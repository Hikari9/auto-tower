import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/core/errors.js';
import { PolicyDeniedError } from '../../src/policy/errors.js';
import { createPolicyService } from '../../src/policy/service.js';
import { seedFixedPrincipal } from '../core/helpers.js';
import {
  createAuthorityHarness,
  grant,
  missionWith,
  request,
  revoke,
  ruleInput,
} from './helpers.js';

function setup() {
  const h = createAuthorityHarness();
  return { h, policy: h.authority.policy };
}

describe('default deny', () => {
  it('denies everything when no rule exists, and says why', () => {
    const { policy } = setup();
    const evaluation = policy.authorize(request());
    expect(evaluation).toMatchObject({
      effect: 'deny',
      code: 'no_matching_grant',
      ruleId: null,
      policyVersion: 0,
      policyRef: 'policy:v0:no_matching_grant',
    });
  });

  it('allows only what an active grant covers, naming the rule and its versions', () => {
    const { h, policy } = setup();
    const rule = grant(h);
    const allowed = policy.authorize(request());
    expect(allowed).toMatchObject({
      effect: 'allow',
      code: 'granted',
      ruleId: rule.id,
      ruleVersion: 1,
      policyVersion: 1,
    });
    expect(allowed.policyRef).toBe(`policy:v1:rule:${rule.id}@1`);

    for (const miss of [
      request({ action: 'deploy.preview' }),
      request({ resource: 'repo:other' }),
      request({ scope: 'env:prod-like' }),
      request({ risk: 'high' }),
      request({ principal: 'prn_runner' }),
      request({ principal: 'prn_owner' }),
    ]) {
      expect(policy.authorize(miss).effect).toBe('deny');
    }
  });

  it('matches wildcard patterns and a grant held by one named principal', () => {
    const { h, policy } = setup();
    grant(h, {
      action: 'deploy.*',
      resource: 'repo:*',
      scope: 'env:*',
      grantee: { kind: null, principalId: 'prn_cos' },
    });
    expect(policy.authorize(request({ action: 'deploy.preview' })).effect).toBe(
      'allow',
    );
    seedFixedPrincipal(h.db, 'prn_cos_two', 'chief_of_staff');
    expect(policy.authorize(request({ principal: 'prn_cos_two' })).effect).toBe(
      'deny',
    );
  });

  it('takes the principal kind from the store, never from the caller', () => {
    const { h, policy } = setup();
    grant(h, { grantee: { kind: 'human', principalId: null } });
    const asRunner = policy.authorize(
      request({ principal: { id: 'prn_runner' } }),
    );
    expect(asRunner.effect).toBe('deny');
  });

  it.each([['an unknown principal', 'prn_nobody', 'unknown_principal']])(
    'denies %s',
    (_name, principal, code) => {
      const { h, policy } = setup();
      grant(h);
      expect(policy.authorize(request({ principal })).code).toBe(code);
    },
  );

  it('denies a principal from another workspace and a disabled principal', () => {
    const { h, policy } = setup();
    grant(h, { grantee: { kind: 'human', principalId: null } });
    seedFixedPrincipal(h.db, 'prn_foreign', 'human', 'ws_elsewhere');
    expect(policy.authorize(request({ principal: 'prn_foreign' })).code).toBe(
      'unknown_principal',
    );
    h.db.run('UPDATE principals SET disabled_at = ? WHERE id = ?', [
      '2026-01-01T00:00:00.000Z',
      'prn_owner',
    ]);
    expect(policy.authorize(request({ principal: 'prn_owner' })).code).toBe(
      'principal_disabled',
    );
  });

  it('rejects a malformed request instead of guessing', () => {
    const { policy } = setup();
    expect(() => policy.authorize(request({ action: 'Deploy Now' }))).toThrow(
      ValidationError,
    );
    expect(() => policy.authorize(request({ amount: 1.5 }))).toThrow(
      ValidationError,
    );
    expect(() => policy.authorize(request({ resource: '' }))).toThrow(
      ValidationError,
    );
  });
});

describe('limits', () => {
  it('covers an amount only up to a stated cap', () => {
    const { h, policy } = setup();
    grant(h, {
      action: 'spend.compute',
      resource: 'account:main',
      scope: 'month:2026-03',
      limits: { maxAmount: 500, missionIds: null },
    });
    const spend = (amount?: number) =>
      policy.authorize(
        request({
          action: 'spend.compute',
          resource: 'account:main',
          scope: 'month:2026-03',
          amount,
        }),
      );
    expect(spend(500).effect).toBe('allow');
    expect(spend(501).effect).toBe('deny');
    expect(spend(0).effect).toBe('allow');
  });

  it('treats a grant without a cap as covering no amount at all', () => {
    const { h, policy } = setup();
    grant(h);
    expect(policy.authorize(request({ amount: 1 })).effect).toBe('deny');
    expect(policy.authorize(request()).effect).toBe('allow');
  });

  it('covers only the named missions', () => {
    const { h, policy } = setup();
    grant(h, { limits: { maxAmount: null, missionIds: ['msn_a'] } });
    expect(policy.authorize(request({ missionId: 'msn_a' })).effect).toBe(
      'allow',
    );
    expect(policy.authorize(request({ missionId: 'msn_b' })).effect).toBe(
      'deny',
    );
    expect(policy.authorize(request()).effect).toBe('deny');
  });
});

describe('explicit deny', () => {
  it('beats any allow, whichever was written first', () => {
    const { h, policy } = setup();
    const broad = grant(h, {
      action: '*',
      resource: '*',
      scope: '*',
      maxRisk: 'high',
    });
    const deny = h.authority.policy.createRule(
      h.ctx(h.owner),
      ruleInput({
        effect: 'deny',
        action: 'deploy.*',
        resource: 'repo:app',
        scope: '*',
        grantee: { kind: null, principalId: null },
      }),
    ).rule;
    const evaluation = policy.authorize(request());
    expect(evaluation).toMatchObject({
      effect: 'deny',
      code: 'explicit_deny',
      ruleId: deny.id,
    });
    // The allow still covers what the deny does not touch.
    expect(policy.authorize(request({ action: 'docs.publish' })).ruleId).toBe(
      broad.id,
    );
  });

  it('applies to everyone when it names no grantee, and to one kind when it does', () => {
    const { h, policy } = setup();
    grant(h, { grantee: { kind: null, principalId: 'prn_cos' } });
    h.authority.policy.createRule(
      h.ctx(h.owner),
      ruleInput({
        effect: 'deny',
        grantee: { kind: 'chief_of_staff', principalId: null },
      }),
    );
    expect(policy.authorize(request()).code).toBe('explicit_deny');
  });

  it('blocks safe cleanup too, so an emergency halt rule really halts', () => {
    const { h, policy } = setup();
    const cleanup = request({
      action: 'cleanup.release-lease',
      resource: 'lease:1',
      scope: 'runner:a',
      principal: h.owner.id,
    });
    expect(policy.authorize(cleanup).code).toBe('safe_cleanup');
    h.authority.policy.createRule(
      h.ctx(h.owner),
      ruleInput({
        effect: 'deny',
        action: '*',
        resource: '*',
        scope: '*',
        grantee: { kind: null, principalId: null },
      }),
    );
    expect(policy.authorize(cleanup).code).toBe('explicit_deny');
  });

  it('stops applying once it is revoked', () => {
    const { h, policy } = setup();
    grant(h);
    const deny = h.authority.policy.createRule(
      h.ctx(h.owner),
      ruleInput({ effect: 'deny', grantee: { kind: null, principalId: null } }),
    ).rule;
    expect(policy.authorize(request()).effect).toBe('deny');
    revoke(h, deny.id, 1);
    expect(policy.authorize(request()).effect).toBe('allow');
  });
});

describe('expiry and revocation', () => {
  it('stops allowing at the expiry instant and says the grant expired', () => {
    const { h, policy } = setup();
    const rule = grant(h, { expiresAt: '2026-03-01T01:00:00.000Z' });
    expect(policy.authorize(request()).effect).toBe('allow');
    h.clock.advance(60 * 60 * 1000 - 1);
    expect(policy.authorize(request()).effect).toBe('allow');
    h.clock.advance(1);
    expect(policy.authorize(request())).toMatchObject({
      effect: 'deny',
      code: 'grant_expired',
      ruleId: rule.id,
    });
  });

  it('refuses to create a grant that has already expired', () => {
    const { h, policy } = setup();
    expect(() =>
      policy.createRule(
        h.ctx(h.owner),
        ruleInput({ expiresAt: '2026-02-28T00:00:00.000Z' }),
      ),
    ).toThrow(ValidationError);
  });

  it('denies at once after revocation, reading the latest committed policy each call', () => {
    const { h, policy } = setup();
    const rule = grant(h);
    // A second service over the same database, as another request handler would hold.
    const elsewhere = createPolicyService({ db: h.db, clock: h.clock.now });
    expect(elsewhere.authorize(request()).effect).toBe('allow');
    const revoked = revoke(h, rule.id, 1);
    expect(revoked.version).toBe(2);
    expect(elsewhere.authorize(request())).toMatchObject({
      effect: 'deny',
      code: 'grant_revoked',
      ruleId: rule.id,
      ruleVersion: 2,
      policyVersion: 2,
    });
    expect(policy.authorize(request()).effect).toBe('deny');
  });

  it('evaluates against the version of a grant as amended, not as first written', () => {
    const { h, policy } = setup();
    const rule = grant(h, { maxRisk: 'low' });
    expect(policy.authorize(request({ risk: 'medium' })).effect).toBe('deny');
    policy.amendRule(h.ctx(h.owner), rule.id, 1, { maxRisk: 'medium' });
    expect(policy.authorize(request({ risk: 'medium' }))).toMatchObject({
      effect: 'allow',
      ruleVersion: 2,
      policyVersion: 2,
    });
    policy.amendRule(h.ctx(h.owner), rule.id, 2, { maxRisk: 'low' });
    expect(policy.authorize(request({ risk: 'medium' })).effect).toBe('deny');
  });
});

describe('sensitive actions', () => {
  const sensitive = [
    ['spend.compute', 'account:main', 'month:2026-03', { amount: 100 }],
    ['deploy.production', 'service:web', 'env:production', {}],
    ['security.disable-scan', 'repo:app', 'ci', {}],
    ['destructive.truncate', 'db:main', 'env:staging', {}],
    ['repo.delete', 'repo:app', 'org:favor', {}],
    ['issue.close', 'issue:app#12', 'repo:app', {}],
  ] as const;

  it.each(sensitive)(
    'denies %s with no grant',
    (action, resource, scope, extra) => {
      const { policy } = setup();
      expect(
        policy.authorize(request({ action, resource, scope, ...extra })).effect,
      ).toBe('deny');
    },
  );

  it.each(sensitive)(
    'denies %s under a grant that is not explicit',
    (action, resource, scope, extra) => {
      const { h, policy } = setup();
      grant(h, {
        action: '*',
        resource: '*',
        scope: '*',
        maxRisk: 'high',
        limits: {
          maxAmount: 'amount' in extra ? 1_000_000 : null,
          missionIds: null,
        },
      });
      const evaluation = policy.authorize(
        request({ action, resource, scope, ...extra }),
      );
      expect(evaluation).toMatchObject({
        effect: 'deny',
        code: 'sensitive_requires_explicit_grant',
      });
      // Wildcards that still stand in for a name are not explicit either.
      grant(h, {
        action,
        resource: '*',
        scope,
        limits: {
          maxAmount: 'amount' in extra ? 1_000_000 : null,
          missionIds: null,
        },
      });
      expect(
        policy.authorize(request({ action, resource, scope, ...extra })).effect,
      ).toBe('deny');
    },
  );

  it.each(sensitive)(
    'allows %s once a grant names the action, resource and scope',
    (action, resource, scope, extra) => {
      const { h, policy } = setup();
      grant(h, {
        action,
        resource,
        scope,
        limits: {
          maxAmount: 'amount' in extra ? 1_000 : null,
          missionIds: null,
        },
      });
      expect(
        policy.authorize(request({ action, resource, scope, ...extra })).effect,
      ).toBe('allow');
    },
  );

  it('still lets a wildcard grant cover ordinary actions', () => {
    const { h, policy } = setup();
    grant(h, { action: '*', resource: '*', scope: '*' });
    expect(policy.authorize(request({ action: 'docs.publish' })).effect).toBe(
      'allow',
    );
  });
});

describe('revoking between dispatch and effect', () => {
  it('denies the next guarded effect, keeps safe cleanup, and leaves a receipt', () => {
    const { h, policy } = setup();
    const rule = grant(h, {
      action: 'land.merge',
      resource: 'repo:app',
      scope: 'branch:main',
      grantee: { kind: 'chief_of_staff', principalId: null },
    });
    const { driver, ids } = missionWith(h, [
      { title: 'one', scope: ['branch:main'] },
    ]);
    const dispatchCheck = request({
      action: 'land.merge',
      resource: 'repo:app',
      scope: 'branch:main',
      missionId: driver.id,
    });

    // Dispatch: the grant allows, and the work is authorized under the evaluation's reference.
    const atDispatch = policy.authorize(dispatchCheck);
    expect(atDispatch.effect).toBe('allow');
    driver.authorize(ids[0] as string, h.cos, [atDispatch.policyRef]);
    h.pool.online = [h.runner.id];
    driver.tick();
    expect(driver.refresh().packets[0]?.status).toBe('leased');

    // The grant is revoked while the work is in flight.
    revoke(h, rule.id, 1);

    // The effect rechecks current authority and does not rely on the reference stored at dispatch.
    expect(() => policy.guard(dispatchCheck)).toThrow(PolicyDeniedError);
    const receipts = policy.receipts('ws_test', { afterSeq: 0, limit: 10 });
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      principalId: 'prn_cos',
      action: 'land.merge',
      effect: 'deny',
      code: 'grant_revoked',
      ruleId: rule.id,
      missionId: driver.id,
    });

    // Safe, non-privileged cleanup is still allowed for the runner holding the lease.
    const cleanup = policy.guard(
      request({
        principal: h.runner.id,
        action: 'cleanup.release-lease',
        resource: `mission:${driver.id}`,
        scope: 'runner:prn_runner',
        missionId: driver.id,
        attemptId: driver.refresh().packets[0]?.activeAttemptId ?? undefined,
      }),
    );
    expect(cleanup.code).toBe('safe_cleanup');
  });

  it('records no receipt for an allowed effect', () => {
    const { h, policy } = setup();
    grant(h);
    policy.guard(request());
    expect(policy.receipts('ws_test', { afterSeq: 0, limit: 10 })).toEqual([]);
  });
});

describe('independent review', () => {
  const review = (principal: string, overrides = {}) =>
    request({
      principal,
      action: 'review.independent.approve',
      resource: 'repo:app',
      scope: 'pull:12',
      ...overrides,
    });

  function producedMission() {
    const { h, policy } = setup();
    const { driver, ids } = missionWith(h, [{ title: 'build' }]);
    driver.authorize(ids[0] as string);
    h.pool.online = [h.runner.id];
    driver.tick();
    driver.runAttempt(ids[0] as string);
    return { h, policy, driver };
  }

  it('is never satisfied by the producer, whatever grants exist', () => {
    const { h, policy, driver } = producedMission();
    grant(h, {
      action: 'review.independent.approve',
      resource: 'repo:app',
      scope: 'pull:12',
      grantee: { kind: 'runner', principalId: null },
    });
    const evaluation = policy.authorize(
      review(h.runner.id, { missionId: driver.id }),
    );
    expect(evaluation).toMatchObject({
      effect: 'deny',
      code: 'producer_cannot_review',
    });
  });

  it('is not satisfied by a delegated landing grant either', () => {
    const { h, policy, driver } = producedMission();
    grant(h, { action: '*', resource: '*', scope: '*', maxRisk: 'high' });
    grant(h, {
      action: 'land.merge',
      resource: 'repo:app',
      scope: 'pull:12',
    });
    expect(
      policy.authorize(review(h.cos.id, { missionId: driver.id })).effect,
    ).toBe('deny');
  });

  it('can be satisfied by someone who did not produce the work and holds an explicit grant', () => {
    const { h, policy, driver } = producedMission();
    grant(h, {
      action: 'review.independent.approve',
      resource: 'repo:app',
      scope: 'pull:12',
      grantee: { kind: 'human', principalId: null },
    });
    expect(
      policy.authorize(review(h.owner.id, { missionId: driver.id })).effect,
    ).toBe('allow');
  });

  it('counts producers the caller names as well as those the mission records', () => {
    const { h, policy } = setup();
    grant(h, {
      action: 'review.independent.approve',
      resource: 'repo:app',
      scope: 'pull:12',
      grantee: { kind: 'human', principalId: null },
    });
    expect(policy.authorize(review(h.owner.id)).effect).toBe('allow');
    expect(
      policy.authorize(review(h.owner.id, { producerIds: [h.owner.id] })).code,
    ).toBe('producer_cannot_review');
  });
});

describe('what evaluation ignores', () => {
  it('is not changed by preferences or a pending proposal', () => {
    const { h, policy } = setup();
    const before = [request(), request({ action: 'docs.publish' })].map((r) =>
      policy.authorize(r),
    );
    policy.setPreference(h.ctx(h.owner), 'auto-approve:deploy.staging', true);
    policy.setPreference(h.ctx(h.owner), 'grant:cos:everything', {
      action: '*',
      allow: true,
    });
    for (const n of [1, 2, 3]) {
      policy.observeApproval('ws_test', {
        decisionId: `dec_${n}`,
        action: 'deploy.staging',
        resource: 'repo:app',
        scope: 'env:staging',
        risk: 'low',
        amount: null,
        approvedBy: h.owner.id,
        at: '2026-03-01T00:00:00.000Z',
      });
    }
    expect(policy.listProposals('ws_test', 'pending')).toHaveLength(1);
    const after = [request(), request({ action: 'docs.publish' })].map((r) =>
      policy.authorize(r),
    );
    expect(after).toEqual(before);
    expect(after.every((e) => e.effect === 'deny')).toBe(true);
    expect(after[0]?.policyVersion).toBe(0);
  });
});

describe('what counts as an explicit grant, and what a cap needs', () => {
  const SPEND = {
    action: 'spend.card',
    resource: 'account:main',
    scope: 'month:2026-03',
    limits: { maxAmount: 100, missionIds: null },
  };

  it.each([
    ['**', '**'],
    ['***', '*'],
    ['*', '**'],
  ])(
    'does not let a resource of %s and a scope of %s stand in for names',
    (resource, scope) => {
      const { h, policy } = setup();
      grant(h, { ...SPEND, resource, scope, maxRisk: 'high' });
      expect(
        policy.authorize(
          request({
            action: 'spend.card',
            resource: 'anything:x',
            scope: 'prod',
            amount: 50,
            risk: 'high',
          }),
        ).code,
      ).toBe('sensitive_requires_explicit_grant');
    },
  );

  it('requires a spend request to state its amount, even under a capped grant', () => {
    const { h, policy } = setup();
    grant(h, SPEND);
    const ask = (amount?: number) =>
      policy.authorize(
        request({
          action: 'spend.card',
          resource: 'account:main',
          scope: 'month:2026-03',
          amount,
        }),
      );
    expect(ask(50).effect).toBe('allow');
    expect(ask()).toMatchObject({ effect: 'deny', code: 'amount_required' });
  });

  it('does not let a request that omits the amount slip past the cap of an ordinary grant', () => {
    const { h, policy } = setup();
    grant(h, { limits: { maxAmount: 100, missionIds: null } });
    expect(policy.authorize(request()).effect).toBe('deny');
    expect(policy.authorize(request({ amount: 100 })).effect).toBe('allow');
    expect(policy.authorize(request({ amount: 101 })).effect).toBe('deny');
  });

  it('refuses a request that names a wildcard instead of one thing', () => {
    const { policy } = setup();
    expect(() => policy.authorize(request({ resource: 'repo:*' }))).toThrow(
      ValidationError,
    );
    expect(() => policy.authorize(request({ scope: '*' }))).toThrow(
      ValidationError,
    );
  });
});
