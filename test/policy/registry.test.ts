import { describe, expect, it } from 'vitest';
import { categoryOf, isDestructiveResource } from '../../src/policy/actions.js';
import { seedFixedPrincipal } from '../core/helpers.js';
import {
  type AuthorityHarness,
  createAuthorityHarness,
  grant,
  missionWith,
  request,
} from './helpers.js';

function setup() {
  const h = createAuthorityHarness();
  return { h, policy: h.authority.policy };
}

describe('the sensitive-action registry', () => {
  const wildcard = (maxAmount: number | null) => ({
    action: '*',
    resource: '*',
    scope: '*',
    maxRisk: 'high' as const,
    grantee: { kind: 'chief_of_staff' as const, principalId: null },
    limits: { maxAmount, missionIds: null },
  });

  it.each([
    ['deploy.live', 'production_deploy', {}],
    ['billing.charge', 'spend', { amount: 5 }],
    ['payment.send', 'spend', { amount: 5 }],
  ])('%s is %s and needs a grant that names it', (action, category, extra) => {
    const { h, policy } = setup();
    expect(categoryOf(action)).toBe(category);
    const ask = () =>
      policy.authorize(
        request({
          principal: h.cos.id,
          action,
          resource: 'repo:app',
          scope: 'env:live',
          ...extra,
        }),
      );
    expect(ask().code).toBe('no_matching_grant');
    const maxAmount = 'amount' in extra ? 10 : null;
    grant(h, wildcard(maxAmount));
    expect(ask()).toMatchObject({
      effect: 'deny',
      code: 'sensitive_requires_explicit_grant',
    });
    grant(h, {
      action,
      resource: 'repo:app',
      scope: 'env:live',
      maxRisk: 'high',
      limits: { maxAmount, missionIds: null },
    });
    expect(ask()).toMatchObject({ effect: 'allow', code: 'granted' });
  });

  it('refuses a spend that states no amount', () => {
    const { h, policy } = setup();
    grant(h, {
      action: 'billing.charge',
      resource: 'repo:app',
      scope: 'env:live',
      limits: { maxAmount: 10, missionIds: null },
    });
    expect(
      policy.authorize(request({ action: 'billing.charge', scope: 'env:live' }))
        .code,
    ).toBe('amount_required');
  });

  it('matches whole segments only, wherever they sit in the name', () => {
    expect(categoryOf('ops.deploy.live.eu')).toBe('production_deploy');
    expect(categoryOf('deploy-live')).toBe('standard');
    expect(categoryOf('deployments.live')).toBe('standard');
    expect(categoryOf('payments.send')).toBe('spend');
    expect(categoryOf('paymentsx.send')).toBe('standard');
  });
});

/** A mission with one authorized packet leased to the harness runner. */
function leased(h: AuthorityHarness) {
  const { driver, ids } = missionWith(h, [
    { title: 'one', scope: ['tmp/*'], authorized: true },
  ]);
  h.pool.online = [h.runner.id];
  driver.tick();
  const attemptId = driver.refresh().packets[0]?.activeAttemptId as string;
  return { driver, packetId: ids[0] as string, attemptId };
}

describe('grantless cleanup', () => {
  const cleanup = (h: AuthorityHarness, principal: string, extra = {}) =>
    h.authority.policy.authorize(
      request({
        principal,
        action: 'cleanup.release-lease',
        resource: 'files:tmp',
        scope: 'runner:a',
        ...extra,
      }),
    );

  it('is allowed to the runner holding the attempt lease', () => {
    const { h } = setup();
    const { driver, attemptId } = leased(h);
    expect(
      cleanup(h, h.runner.id, { missionId: driver.id, attemptId }).code,
    ).toBe('safe_cleanup');
  });

  it('is allowed to a human with no attempt at all', () => {
    const { h } = setup();
    expect(cleanup(h, h.owner.id).code).toBe('safe_cleanup');
  });

  it.each([
    ['a runner that names no attempt', {}],
    ['a runner naming an attempt it does not hold', { other: true }],
    ['a runner whose attempt is not in the named mission', { noMission: true }],
  ])('is not allowed to %s', (_name, mode: Record<string, boolean>) => {
    const { h } = setup();
    const { driver, attemptId } = leased(h);
    const second = seedFixedPrincipal(h.db, 'prn_runner2', 'runner');
    const extra =
      mode.other === true
        ? { missionId: driver.id, attemptId }
        : mode.noMission === true
          ? { attemptId }
          : {};
    const principal = mode.other === true ? second.id : h.runner.id;
    expect(cleanup(h, principal, extra)).toMatchObject({
      effect: 'deny',
      code: 'no_matching_grant',
    });
  });

  it('is not allowed to a chief of staff, who holds no lease', () => {
    const { h } = setup();
    const { driver, attemptId } = leased(h);
    expect(
      cleanup(h, h.cos.id, { missionId: driver.id, attemptId }).effect,
    ).toBe('deny');
  });

  it('ends with the lease, once the attempt has reported', () => {
    const { h } = setup();
    const { driver, packetId, attemptId } = leased(h);
    driver.runAttempt(packetId);
    expect(
      cleanup(h, h.runner.id, { missionId: driver.id, attemptId }).effect,
    ).toBe('deny');
  });

  it('is never allowed for a destructive resource, even to a human or the lease holder', () => {
    const { h } = setup();
    const { driver, attemptId } = leased(h);
    for (const resource of ['db:orders', 'env:prod', 'backups/nightly']) {
      expect(isDestructiveResource(resource)).toBe(true);
      expect(cleanup(h, h.owner.id, { resource }).effect).toBe('deny');
      expect(
        cleanup(h, h.runner.id, { resource, missionId: driver.id, attemptId })
          .effect,
      ).toBe('deny');
    }
    expect(isDestructiveResource('*')).toBe(true);
    expect(isDestructiveResource('files:tmp')).toBe(false);
  });

  it('can still be granted for anyone, like any other action', () => {
    const { h } = setup();
    grant(h, {
      action: 'cleanup.release-lease',
      resource: 'db:orders',
      scope: 'runner:a',
      grantee: { kind: 'chief_of_staff', principalId: null },
    });
    expect(cleanup(h, h.cos.id, { resource: 'db:orders' }).code).toBe(
      'granted',
    );
  });
});
