import { describe, expect, it } from 'vitest';
import { PolicyDeniedError } from '../../src/policy/errors.js';
import { seedFixedPrincipal } from '../core/helpers.js';
import {
  createAuthorityHarness,
  grant,
  request,
  revoke,
  ruleInput,
} from './helpers.js';

function setup() {
  const h = createAuthorityHarness();
  return { h, policy: h.authority.policy };
}

describe('a sensitive action needs every part of the grant named', () => {
  const SENSITIVE = {
    action: 'deploy.production',
    resource: 'service:web',
    scope: 'env:production',
  };

  it.each([
    ['a wildcard scope', { scope: '*' }],
    ['a wildcard resource', { resource: '*' }],
    ['a wildcard action', { action: 'deploy.*' }],
    ['a bare wildcard action', { action: '*' }],
  ])('is not satisfied by %s', (_name, override) => {
    const { h, policy } = setup();
    grant(h, { ...SENSITIVE, maxRisk: 'high', ...override });
    expect(policy.authorize(request(SENSITIVE))).toMatchObject({
      effect: 'deny',
      code: 'sensitive_requires_explicit_grant',
    });
  });

  it('is satisfied when all three are named, and a prefix pattern still counts as scoped', () => {
    const { h, policy } = setup();
    grant(h, { ...SENSITIVE, scope: 'env:prod*' });
    expect(policy.authorize(request(SENSITIVE)).effect).toBe('allow');
  });

  it.each(['destroy', 'purge', 'wipe', 'delete', 'drop', 'force-push'])(
    'treats a final segment of %s as destructive',
    (verb) => {
      const { h, policy } = setup();
      grant(h, { action: '*', resource: '*', scope: '*', maxRisk: 'high' });
      expect(policy.authorize(request({ action: `repo.${verb}` })).code).toBe(
        'sensitive_requires_explicit_grant',
      );
    },
  );
});

describe('rule lifecycle details', () => {
  it('stops applying an expired deny rule', () => {
    const { h, policy } = setup();
    grant(h);
    h.authority.policy.createRule(
      h.ctx(h.owner),
      ruleInput({
        effect: 'deny',
        grantee: { kind: null, principalId: null },
        expiresAt: '2026-03-01T00:10:00.000Z',
      }),
    );
    expect(policy.authorize(request()).code).toBe('explicit_deny');
    h.clock.advance(10 * 60 * 1000);
    expect(policy.authorize(request()).effect).toBe('allow');
  });

  it('names the rule version it matched in the reference, as amended', () => {
    const { h, policy } = setup();
    const rule = grant(h);
    policy.amendRule(h.ctx(h.owner), rule.id, 1, { note: 'a' });
    policy.amendRule(h.ctx(h.owner), rule.id, 2, { note: 'b' });
    expect(policy.authorize(request()).policyRef).toBe(
      `policy:v3:rule:${rule.id}@3`,
    );
  });

  it('lists only live rules as active, and refuses to amend a rule to a past expiry', () => {
    const { h, policy } = setup();
    const rule = grant(h, { expiresAt: '2026-03-01T00:05:00.000Z' });
    grant(h, { action: 'docs.publish' });
    expect(policy.listRules('ws_test', { status: 'active' })).toHaveLength(2);
    h.clock.advance(5 * 60 * 1000);
    expect(policy.listRules('ws_test', { status: 'active' })).toHaveLength(1);
    expect(policy.listRules('ws_test', { status: 'inactive' })).toHaveLength(1);
    expect(() =>
      policy.amendRule(h.ctx(h.owner), rule.id, 1, {
        expiresAt: '2026-03-01T00:01:00.000Z',
      }),
    ).toThrow(/future/);
    expect(
      policy.amendRule(h.ctx(h.owner), rule.id, 1, {
        expiresAt: '2026-04-01T00:00:00.000Z',
      }).rule.expiresAt,
    ).toBe('2026-04-01T00:00:00.000Z');
  });

  it('answers guard for an unknown principal with a refusal and no receipt', () => {
    const { h, policy } = setup();
    grant(h);
    expect(() => policy.guard(request({ principal: 'prn_nobody' }))).toThrow(
      PolicyDeniedError,
    );
    expect(policy.receipts('ws_test', { afterSeq: 0, limit: 10 })).toEqual([]);
    expect(h.cos.id).toBeDefined();
  });

  it('keeps receipts, proposals and preferences inside their workspace', () => {
    const { h, policy } = setup();
    const foreign = seedFixedPrincipal(
      h.db,
      'prn_foreign',
      'human',
      'ws_elsewhere',
    );
    const rule = grant(h);
    revoke(h, rule.id, 1);
    expect(() => policy.guard(request())).toThrow();
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
    policy.setPreference(h.ctx(h.owner), 'tone', 'brief');
    expect(policy.receipts('ws_test', { afterSeq: 0, limit: 10 })).toHaveLength(
      1,
    );
    expect(policy.listProposals('ws_test')).toHaveLength(1);
    expect(policy.receipts('ws_elsewhere', { afterSeq: 0, limit: 10 })).toEqual(
      [],
    );
    expect(policy.listProposals('ws_elsewhere')).toEqual([]);
    expect(policy.listPreferences('ws_elsewhere')).toEqual([]);
    const proposalId = policy.listProposals('ws_test')[0]?.id as string;
    expect(policy.getProposal('ws_elsewhere', proposalId)).toBeUndefined();
    expect(() =>
      policy.acceptProposal(
        { workspaceId: 'ws_elsewhere', actor: foreign },
        proposalId,
        null,
      ),
    ).toThrow(/not found/);
  });
});
