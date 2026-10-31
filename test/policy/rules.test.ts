import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../src/core/errors.js';
import { VersionConflictError } from '../../src/events/errors.js';
import {
  AuthorityForbiddenError,
  RuleNotFoundError,
  RuleStateError,
} from '../../src/policy/errors.js';
import { seedFixedPrincipal } from '../core/helpers.js';
import {
  createAuthorityHarness,
  grant,
  request,
  ruleInput,
} from './helpers.js';

function setup() {
  const h = createAuthorityHarness();
  return { h, policy: h.authority.policy };
}

describe('rules are versioned and attributable', () => {
  it('records who made each change and bumps the rule and policy versions', () => {
    const { h, policy } = setup();
    const created = policy.createRule(h.ctx(h.owner), ruleInput());
    expect(created).toMatchObject({
      policyVersion: 1,
      replayed: false,
      rule: { version: 1, createdBy: h.owner.id, updatedBy: h.owner.id },
    });

    const amended = policy.amendRule(h.ctx(h.other), created.rule.id, 1, {
      resource: 'repo:*',
      note: 'wider',
    });
    expect(amended.policyVersion).toBe(2);
    expect(amended.rule).toMatchObject({
      version: 2,
      resource: 'repo:*',
      note: 'wider',
      createdBy: h.owner.id,
      updatedBy: h.other.id,
    });

    h.clock.advance(1000);
    const revoked = policy.revokeRule(
      h.ctx(h.owner),
      created.rule.id,
      2,
      'done',
    );
    expect(revoked.policyVersion).toBe(3);
    expect(revoked.rule).toMatchObject({
      version: 3,
      revokedBy: h.owner.id,
      revokeReason: 'done',
      revokedAt: '2026-03-01T00:00:01.000Z',
    });
    expect(policy.policyVersion('ws_test')).toBe(3);
  });

  it('refuses an amendment or revocation based on a stale version', () => {
    const { h, policy } = setup();
    const rule = grant(h);
    policy.amendRule(h.ctx(h.owner), rule.id, 1, { note: 'a' });
    expect(() =>
      policy.amendRule(h.ctx(h.owner), rule.id, 1, { note: 'b' }),
    ).toThrow(VersionConflictError);
    expect(() => policy.revokeRule(h.ctx(h.owner), rule.id, 1, null)).toThrow(
      VersionConflictError,
    );
    expect(policy.getRule('ws_test', rule.id)?.note).toBe('a');
  });

  it('keeps a revoked rule for audit and refuses to amend or revoke it again', () => {
    const { h, policy } = setup();
    const rule = grant(h);
    policy.revokeRule(h.ctx(h.owner), rule.id, 1, null);
    expect(policy.getRule('ws_test', rule.id)?.revokedAt).not.toBeNull();
    expect(() =>
      policy.amendRule(h.ctx(h.owner), rule.id, 2, { note: 'x' }),
    ).toThrow(RuleStateError);
    expect(() => policy.revokeRule(h.ctx(h.owner), rule.id, 2, null)).toThrow(
      RuleStateError,
    );
    expect(policy.listRules('ws_test', { status: 'active' })).toEqual([]);
    expect(policy.listRules('ws_test', { status: 'inactive' })).toHaveLength(1);
  });

  it('does not find a rule from another workspace', () => {
    const { h, policy } = setup();
    const rule = grant(h);
    const foreign = seedFixedPrincipal(
      h.db,
      'prn_foreign',
      'human',
      'ws_elsewhere',
    );
    expect(policy.getRule('ws_elsewhere', rule.id)).toBeUndefined();
    expect(() =>
      policy.revokeRule(
        { workspaceId: 'ws_elsewhere', actor: foreign },
        rule.id,
        1,
        null,
      ),
    ).toThrow(RuleNotFoundError);
    expect(policy.listRules('ws_elsewhere')).toEqual([]);
    expect(
      policy.authorize(
        request({ workspace: 'ws_elsewhere', principal: foreign.id }),
      ).effect,
    ).toBe('deny');
  });

  it('keeps a deny rule applying at every risk', () => {
    const { h, policy } = setup();
    const deny = policy.createRule(
      h.ctx(h.owner),
      ruleInput({ effect: 'deny', grantee: { kind: null, principalId: null } }),
    ).rule;
    expect(deny.maxRisk).toBe('high');
    expect(() =>
      policy.createRule(
        h.ctx(h.owner),
        ruleInput({
          effect: 'deny',
          grantee: { kind: null, principalId: null },
          limits: { maxAmount: 10, missionIds: null },
        }),
      ),
    ).toThrow(ValidationError);
  });

  it('needs a grantee for a grant, and the grantee must belong to the workspace', () => {
    const { h, policy } = setup();
    expect(() =>
      policy.createRule(
        h.ctx(h.owner),
        ruleInput({ grantee: { kind: null, principalId: null } }),
      ),
    ).toThrow(ValidationError);
    seedFixedPrincipal(
      h.db,
      'prn_foreign_cos',
      'chief_of_staff',
      'ws_elsewhere',
    );
    expect(() =>
      policy.createRule(
        h.ctx(h.owner),
        ruleInput({ grantee: { kind: null, principalId: 'prn_foreign_cos' } }),
      ),
    ).toThrow(ValidationError);
    expect(() =>
      policy.createRule(
        h.ctx(h.owner),
        ruleInput({ grantee: { kind: null, principalId: 'prn_cos' } }),
      ),
    ).not.toThrow();
  });
});

describe('only a human changes authority', () => {
  it.each(['cos', 'runner', 'provider'] as const)(
    'refuses %s for every write',
    (who) => {
      const { h, policy } = setup();
      const rule = grant(h);
      const actor = h[who];
      const ctx = h.ctx(actor);
      expect(() => policy.createRule(ctx, ruleInput())).toThrow(
        AuthorityForbiddenError,
      );
      expect(() => policy.amendRule(ctx, rule.id, 1, { note: 'x' })).toThrow(
        AuthorityForbiddenError,
      );
      expect(() => policy.revokeRule(ctx, rule.id, 1, null)).toThrow(
        AuthorityForbiddenError,
      );
      expect(() => policy.setPreference(ctx, 'k', 1)).toThrow(
        AuthorityForbiddenError,
      );
      expect(() => policy.acceptProposal(ctx, 'prp_x', null)).toThrow(
        AuthorityForbiddenError,
      );
      expect(() => policy.declineProposal(ctx, 'prp_x', null)).toThrow(
        AuthorityForbiddenError,
      );
      expect(() => policy.narrowProposal(ctx, 'prp_x', { note: null })).toThrow(
        AuthorityForbiddenError,
      );
      expect(policy.getRule('ws_test', rule.id)?.version).toBe(1);
      expect(policy.policyVersion('ws_test')).toBe(1);
    },
  );
});

describe('idempotent creation', () => {
  it('returns the same rule for a repeat with the same key', () => {
    const { h, policy } = setup();
    const ctx = h.ctx(h.owner, { idempotencyKey: 'key-1' });
    const first = policy.createRule(ctx, ruleInput());
    const again = policy.createRule(ctx, ruleInput());
    expect(first.replayed).toBe(false);
    expect(again).toMatchObject({
      replayed: true,
      rule: { id: first.rule.id },
    });
    expect(policy.listRules('ws_test')).toHaveLength(1);
    expect(policy.policyVersion('ws_test')).toBe(1);
  });

  it('still recognises the repeat after the rule was amended', () => {
    const { h, policy } = setup();
    const ctx = h.ctx(h.owner, { idempotencyKey: 'key-2' });
    const first = policy.createRule(ctx, ruleInput());
    policy.amendRule(h.ctx(h.owner), first.rule.id, 1, { note: 'later' });
    expect(policy.createRule(ctx, ruleInput()).replayed).toBe(true);
    expect(policy.listRules('ws_test')).toHaveLength(1);
  });

  it('refuses the same key for a different rule', () => {
    const { h, policy } = setup();
    const ctx = h.ctx(h.owner, { idempotencyKey: 'key-3' });
    policy.createRule(ctx, ruleInput());
    expect(() =>
      policy.createRule(ctx, ruleInput({ resource: 'repo:other' })),
    ).toThrow(ValidationError);
  });
});

describe('authority history', () => {
  it('lists every change in order with who, when and the full rule', () => {
    const { h, policy } = setup();
    const rule = grant(h);
    h.clock.advance(1000);
    policy.amendRule(
      h.ctx(h.other, { correlationId: 'cor-amend' }),
      rule.id,
      1,
      {
        maxRisk: 'high',
      },
    );
    h.clock.advance(1000);
    policy.revokeRule(h.ctx(h.owner), rule.id, 2, 'retired');
    const second = grant(h, { action: 'docs.publish' });

    const page = policy.history('ws_test', { afterVersion: 0, limit: 50 });
    expect(page.items.map((i) => i.type)).toEqual([
      'policy.rule.created',
      'policy.rule.amended',
      'policy.rule.revoked',
      'policy.rule.created',
    ]);
    expect(page.items.map((i) => i.actorId)).toEqual([
      h.owner.id,
      h.other.id,
      h.owner.id,
      h.owner.id,
    ]);
    expect(page.items[1]?.correlationId).toBe('cor-amend');
    const payloads = page.items.map(
      (i) =>
        i.payload as {
          rule: {
            id: string;
            version: number;
            maxRisk: string;
            revokedAt: string | null;
          };
          policyVersion: number;
          changed?: string[];
        },
    );
    expect(payloads.map((p) => p.policyVersion)).toEqual([1, 2, 3, 4]);
    expect(payloads.map((p) => p.rule.version)).toEqual([1, 2, 3, 1]);
    expect(payloads[1]).toMatchObject({
      changed: ['maxRisk'],
      rule: { maxRisk: 'high' },
    });
    expect(payloads[2]?.rule.revokedAt).toBe('2026-03-01T00:00:02.000Z');
    expect(page.nextAfterVersion).toBeNull();

    const only = policy.history(
      'ws_test',
      { afterVersion: 0, limit: 50 },
      { ruleId: second.id },
    );
    expect(only.items).toHaveLength(1);
    const first = policy.history(
      'ws_test',
      { afterVersion: 0, limit: 50 },
      { ruleId: rule.id },
    );
    expect(first.items).toHaveLength(3);
  });

  it('pages without skipping or repeating', () => {
    const { h, policy } = setup();
    for (const n of [1, 2, 3]) {
      grant(h, { action: `docs.publish${n}` });
    }
    const one = policy.history('ws_test', { afterVersion: 0, limit: 2 });
    expect(one.items.map((i) => i.version)).toEqual([1, 2]);
    expect(one.nextAfterVersion).toBe(2);
    const two = policy.history('ws_test', { afterVersion: 2, limit: 2 });
    expect(two.items.map((i) => i.version)).toEqual([3]);
    expect(two.nextAfterVersion).toBeNull();
  });

  it('rebuilds the same rules and version from the events alone', () => {
    const { h, policy } = setup();
    const a = grant(h);
    const b = grant(h, { action: 'docs.publish' });
    policy.amendRule(h.ctx(h.owner), a.id, 1, { note: 'x' });
    policy.revokeRule(h.ctx(h.owner), b.id, 1, 'y');
    const rules = policy.listRules('ws_test');
    const version = policy.policyVersion('ws_test');
    h.db.run('UPDATE policy_rules SET action = ?', ['tampered']);
    policy.rebuildProjection('ws_test');
    expect(policy.listRules('ws_test')).toEqual(rules);
    expect(policy.policyVersion('ws_test')).toBe(version);
  });

  it('cannot be edited through the event log', () => {
    const { h } = setup();
    grant(h);
    expect(() =>
      h.db.run(
        "UPDATE events SET type = 'policy.rule.revoked' WHERE stream_id = 'policy'",
      ),
    ).toThrow(/append-only/);
    expect(() =>
      h.db.run("DELETE FROM events WHERE stream_id = 'policy'"),
    ).toThrow(/append-only/);
  });
});

describe('preferences', () => {
  it('are stored apart from rules and versioned', () => {
    const { h, policy } = setup();
    const first = policy.setPreference(h.ctx(h.owner), 'tone', 'brief');
    const second = policy.setPreference(h.ctx(h.owner), 'tone', {
      style: 'plain',
    });
    expect(first.version).toBe(1);
    expect(second).toMatchObject({ version: 2, value: { style: 'plain' } });
    expect(policy.listPreferences('ws_test')).toHaveLength(1);
    expect(policy.listRules('ws_test')).toEqual([]);
    expect(policy.policyVersion('ws_test')).toBe(0);
  });
});
