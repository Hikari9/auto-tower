import { describe, expect, it } from 'vitest';
import { createFlagService } from '../../src/mcp/flags.js';
import { createPolicyService } from '../../src/policy/service.js';
import { key } from './helpers.js';
import { createMcpEnv } from './setup.js';

const RULE = {
  action: 'cloud_ai.triage.run',
  resource: 'provider:acme-ai',
  scope: 'workspace',
  maxRisk: 'medium',
  grantee: { kind: 'human' },
  limits: { maxAmount: 5000 },
};

const ENABLE = {
  flag: 'cloud_ai.triage',
  enabled: true,
  providerId: 'acme-ai',
  budgetCents: 2000,
};

async function envWithProvider() {
  const env = createMcpEnv({ mcp: { approvedAiProviders: ['acme-ai'] } });
  return { env, s: await env.session(env.owner) };
}

const grantRule = (
  s: Awaited<ReturnType<typeof envWithProvider>>['s'],
  overrides = {},
) =>
  s.ok('grant_policy', {
    ...RULE,
    grantee: { kind: 'chief_of_staff' },
    ...overrides,
    idempotencyKey: key(),
    confirm: true,
  });

describe('isEnabled, which a capability calls at the point of effect', () => {
  it('is false for an unset flag, true while approved, and false the moment an approval lapses', async () => {
    const env = createMcpEnv({ mcp: { approvedAiProviders: ['acme-ai'] } });
    const s = await env.session(env.owner);
    const policy = createPolicyService({ db: env.db });
    const flags = (approved: readonly string[]) =>
      createFlagService({
        db: env.db,
        policy,
        approvedProviders: approved,
        now: () => new Date(),
      });
    expect(flags(['acme-ai']).isEnabled('ws_test', 'cloud_ai.triage')).toBe(
      false,
    );

    const { rule } = await grantRule(s);
    await s.ok('set_feature_flag', {
      ...ENABLE,
      policyRuleId: rule.id,
      idempotencyKey: key(),
      confirm: true,
    });
    expect(flags(['acme-ai']).isEnabled('ws_test', 'cloud_ai.triage')).toBe(
      true,
    );
    expect(flags(['acme-ai']).isEnabled('ws_test', 'hosted_execution')).toBe(
      false,
    );
    // Provider no longer approved.
    expect(flags([]).isEnabled('ws_test', 'cloud_ai.triage')).toBe(false);

    await s.ok('revoke_policy', {
      ruleId: rule.id,
      expectedVersion: rule.version,
      idempotencyKey: key(),
      confirm: true,
    });
    expect(flags(['acme-ai']).isEnabled('ws_test', 'cloud_ai.triage')).toBe(
      false,
    );
    const row = env.db.get<{ enabled: number }>(
      "SELECT enabled FROM feature_flags WHERE flag = 'cloud_ai.triage'",
    );
    expect(row?.enabled).toBe(1);
  });

  it('is false when the rule stays but its cap drops below the budget', async () => {
    const env = createMcpEnv({ mcp: { approvedAiProviders: ['acme-ai'] } });
    const s = await env.session(env.owner);
    const policy = createPolicyService({ db: env.db });
    const { rule } = await grantRule(s);
    await s.ok('set_feature_flag', {
      ...ENABLE,
      policyRuleId: rule.id,
      idempotencyKey: key(),
      confirm: true,
    });
    const service = createFlagService({
      db: env.db,
      policy,
      approvedProviders: ['acme-ai'],
      now: () => new Date(),
    });
    expect(service.isEnabled('ws_test', 'cloud_ai.triage')).toBe(true);
    env.db.run('UPDATE feature_flags SET budget_cents = 9000');
    expect(service.isEnabled('ws_test', 'cloud_ai.triage')).toBe(false);
  });
});

describe('feature flags', () => {
  it('exist and default to off', async () => {
    const { s } = await envWithProvider();
    const { flags } = await s.ok('read_feature_flags');
    expect(flags.map((f: { flag: string }) => f.flag).sort()).toEqual([
      'cloud_ai.triage',
      'hosted_execution',
    ]);
    for (const flag of flags) {
      expect(flag).toMatchObject({ enabled: false, requested: false });
    }
  });

  it.each([
    [
      'no provider, budget or policy',
      { flag: 'cloud_ai.triage', enabled: true },
    ],
    [
      'a provider nobody approved',
      { ...ENABLE, providerId: 'rogue-ai', policyRuleId: 'x' },
    ],
    ['no budget', { ...ENABLE, budgetCents: undefined, policyRuleId: 'x' }],
    ['no policy', { ...ENABLE }],
    [
      'a policy rule that does not exist',
      { ...ENABLE, policyRuleId: 'rul_nope' },
    ],
  ])('fails closed when turned on with %s', async (_label, args) => {
    const { s } = await envWithProvider();
    for (const flag of ['cloud_ai.triage', 'hosted_execution'] as const) {
      const reply = await s.call('set_feature_flag', {
        ...args,
        flag,
        idempotencyKey: key(),
        confirm: true,
      });
      expect(reply.isError).toBe(true);
      expect(reply.data.error.code).toBe('flag_requires_approval');
      expect(reply.data.error.details.missing.length).toBeGreaterThan(0);
    }
    const { flags } = await s.ok('read_feature_flags');
    expect(
      flags.every(
        (f: { enabled: boolean; requested: boolean }) =>
          !f.enabled && !f.requested,
      ),
    ).toBe(true);
  });

  it('turns on only with an approved provider, a positive budget and an active rule that covers it', async () => {
    const { s } = await envWithProvider();
    const { rule } = await grantRule(s);
    const on = await s.ok('set_feature_flag', {
      ...ENABLE,
      policyRuleId: rule.id,
      idempotencyKey: key(),
      confirm: true,
    });
    expect(on.flag).toMatchObject({
      flag: 'cloud_ai.triage',
      enabled: true,
      providerId: 'acme-ai',
      budgetCents: 2000,
    });
  });

  it('refuses a budget above what the rule allows', async () => {
    const { s } = await envWithProvider();
    const { rule } = await grantRule(s);
    const reply = await s.call('set_feature_flag', {
      ...ENABLE,
      budgetCents: 9000,
      policyRuleId: rule.id,
      idempotencyKey: key(),
      confirm: true,
    });
    expect(reply.data.error.code).toBe('flag_requires_approval');
  });

  it("refuses a rule for another action, so one flag cannot ride on the other's policy", async () => {
    const { s } = await envWithProvider();
    const { rule } = await grantRule(s);
    const reply = await s.call('set_feature_flag', {
      flag: 'hosted_execution',
      enabled: true,
      providerId: 'acme-ai',
      budgetCents: 100,
      policyRuleId: rule.id,
      idempotencyKey: key(),
      confirm: true,
    });
    expect(reply.data.error.code).toBe('flag_requires_approval');
  });

  it('turns itself off when the policy is revoked, without anyone touching the flag', async () => {
    const { s } = await envWithProvider();
    const { rule } = await grantRule(s);
    await s.ok('set_feature_flag', {
      ...ENABLE,
      policyRuleId: rule.id,
      idempotencyKey: key(),
      confirm: true,
    });
    expect(
      (await s.ok('read_feature_flags')).flags.find(
        (f: { flag: string }) => f.flag === 'cloud_ai.triage',
      ).enabled,
    ).toBe(true);
    await s.ok('revoke_policy', {
      ruleId: rule.id,
      expectedVersion: rule.version,
      idempotencyKey: key(),
      confirm: true,
    });
    const after = (await s.ok('read_feature_flags')).flags.find(
      (f: { flag: string }) => f.flag === 'cloud_ai.triage',
    );
    expect(after).toMatchObject({ requested: true, enabled: false });
    expect(after.blockedBy[0]).toMatch(/policy/);
  });

  it('turns itself off when the provider is no longer approved', async () => {
    const env = createMcpEnv({ mcp: { approvedAiProviders: ['acme-ai'] } });
    const s = await env.session(env.owner);
    const { rule } = await grantRule(s);
    await s.ok('set_feature_flag', {
      ...ENABLE,
      policyRuleId: rule.id,
      idempotencyKey: key(),
      confirm: true,
    });
    // The same database under a deployment that approves no provider.
    const { createApp } = await import('../../src/api/app.js');
    const stricter = createApp({
      db: env.db,
      mcp: { approvedAiProviders: [] },
    });
    const res = await stricter.request('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.owner}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'read_feature_flags', arguments: {} },
      }),
    });
    const flags = (
      (await res.json()) as {
        result: {
          structuredContent: {
            flags: Array<{ flag: string; enabled: boolean }>;
          };
        };
      }
    ).result.structuredContent.flags;
    expect(flags.find((f) => f.flag === 'cloud_ai.triage')?.enabled).toBe(
      false,
    );
  });

  it('lets only a human change a flag, even one holding the scope', async () => {
    const { env } = await envWithProvider();
    const cos = env.seed('chief_of_staff');
    const s = await env.session(cos.token);
    const reply = await s.call('set_feature_flag', {
      flag: 'hosted_execution',
      enabled: false,
      idempotencyKey: key(),
      confirm: true,
    });
    expect(reply.status).toBe(403);
  });

  it('keeps what was approved when it is turned off, and accepts a null budget doing so', async () => {
    const { s } = await envWithProvider();
    const { rule } = await grantRule(s);
    await s.ok('set_feature_flag', {
      ...ENABLE,
      policyRuleId: rule.id,
      idempotencyKey: key(),
      confirm: true,
    });
    const off = await s.ok('set_feature_flag', {
      flag: 'cloud_ai.triage',
      enabled: false,
      budgetCents: null,
      idempotencyKey: key(),
      confirm: true,
    });
    expect(off.flag).toMatchObject({
      enabled: false,
      requested: false,
      providerId: 'acme-ai',
      budgetCents: 2000,
      policyRuleId: rule.id,
    });
  });

  it('turns a flag off without any approval', async () => {
    const { s } = await envWithProvider();
    const off = await s.ok('set_feature_flag', {
      flag: 'hosted_execution',
      enabled: false,
      idempotencyKey: key(),
      confirm: true,
    });
    expect(off.flag).toMatchObject({ enabled: false, requested: false });
  });
});
