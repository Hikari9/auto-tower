import { describe, expect, it } from 'vitest';
import {
  CLOSED_SESSION_RETENTION_MS,
  closeSession,
  findSession,
  openSession,
  SESSION_IDLE_TTL_MS,
} from '../../src/mcp/store.js';
import { openTestDatabase, seedPrincipal } from '../helpers/tower.js';
import { key } from './helpers.js';
import { createMcpEnv, MISSION } from './setup.js';

const RULE = {
  action: 'cloud_ai.triage.run',
  resource: 'provider:acme-ai',
  scope: 'workspace',
  maxRisk: 'medium',
  grantee: { kind: 'chief_of_staff' },
};

const ENABLE = {
  flag: 'cloud_ai.triage',
  enabled: true,
  providerId: 'acme-ai',
  budgetCents: 2000,
};

async function setup() {
  const env = createMcpEnv({ mcp: { approvedAiProviders: ['acme-ai'] } });
  return { env, s: await env.session(env.owner) };
}

describe('feature flag history', () => {
  it('records who, old and new setting, rule and time for every change, and serves it as audit', async () => {
    const { env, s } = await setup();
    const { rule } = await s.ok('grant_policy', {
      ...RULE,
      limits: { maxAmount: 5000 },
      idempotencyKey: key(),
      confirm: true,
    });
    await s.ok('set_feature_flag', {
      ...ENABLE,
      policyRuleId: rule.id,
      idempotencyKey: key(),
      confirm: true,
    });
    await s.ok('set_feature_flag', {
      flag: 'cloud_ai.triage',
      enabled: false,
      idempotencyKey: key(),
      confirm: true,
    });

    const audit = await s.ok('read_audit', { source: 'feature_flags' });
    expect(audit.records).toHaveLength(2);
    expect(audit.records[0]).toMatchObject({
      flag: 'cloud_ai.triage',
      changedBy: env.principals.owner,
      oldEnabled: null,
      newEnabled: true,
      providerId: 'acme-ai',
      budgetCents: 2000,
      policyRuleId: rule.id,
    });
    expect(audit.records[1]).toMatchObject({
      oldEnabled: true,
      newEnabled: false,
      oldPolicyRuleId: rule.id,
    });
    expect(Date.parse(audit.records[0].changedAt)).not.toBeNaN();

    const page = await s.ok('read_audit', {
      source: 'feature_flags',
      afterSeq: audit.records[0].seq,
    });
    expect(page.records).toHaveLength(1);
  });

  it('records nothing for a refused change, and cannot be edited afterwards', async () => {
    const { env, s } = await setup();
    const refused = await s.call('set_feature_flag', {
      ...ENABLE,
      policyRuleId: 'rul_nope',
      idempotencyKey: key(),
      confirm: true,
    });
    expect(refused.isError).toBe(true);
    expect(env.db.all('SELECT seq FROM feature_flag_history')).toHaveLength(0);

    const { rule } = await s.ok('grant_policy', {
      ...RULE,
      limits: { maxAmount: 5000 },
      idempotencyKey: key(),
      confirm: true,
    });
    await s.ok('set_feature_flag', {
      ...ENABLE,
      policyRuleId: rule.id,
      idempotencyKey: key(),
      confirm: true,
    });
    expect(() =>
      env.db.run('UPDATE feature_flag_history SET changed_by = changed_by'),
    ).toThrow(/append-only/);
    expect(() => env.db.run('DELETE FROM feature_flag_history')).toThrow(
      /append-only/,
    );
  });

  it('shows the same history to a chief of staff, who may read policy, and not to a runner', async () => {
    const { env } = await setup();
    const cos = await env.session(env.cos);
    expect(
      (await cos.ok('read_audit', { source: 'tool_calls' })).records,
    ).toBeInstanceOf(Array);
    const runner = await env.session(env.runner);
    expect(
      (await runner.call('read_audit', { source: 'feature_flags' })).status,
    ).toBe(403);
  });
});

describe('a flag needs the rule it names, not any rule', () => {
  it('refuses a flag whose named rule is capped below the budget, though another rule would cover it', async () => {
    const { s } = await setup();
    const narrow = await s.ok('grant_policy', {
      ...RULE,
      limits: { maxAmount: 100 },
      idempotencyKey: key(),
      confirm: true,
    });
    // A second delegated rule covers the use. It is not the one the flag names.
    await s.ok('grant_policy', {
      ...RULE,
      limits: { maxAmount: 5000 },
      idempotencyKey: key(),
      confirm: true,
    });
    const reply = await s.call('set_feature_flag', {
      ...ENABLE,
      policyRuleId: narrow.rule.id,
      idempotencyKey: key(),
      confirm: true,
    });
    expect(reply.isError).toBe(true);
    expect(reply.data.error.code).toBe('flag_requires_approval');
  });

  it('turns an enabled flag off when its named rule is narrowed away, whatever else covers the use', async () => {
    const { env, s } = await setup();
    const named = await s.ok('grant_policy', {
      ...RULE,
      limits: { maxAmount: 5000 },
      idempotencyKey: key(),
      confirm: true,
    });
    await s.ok('set_feature_flag', {
      ...ENABLE,
      policyRuleId: named.rule.id,
      idempotencyKey: key(),
      confirm: true,
    });
    await s.ok('grant_policy', {
      ...RULE,
      limits: { maxAmount: 9000 },
      idempotencyKey: key(),
      confirm: true,
    });
    expect(
      (await s.ok('read_feature_flags')).flags.find(
        (f: { flag: string }) => f.flag === 'cloud_ai.triage',
      ).enabled,
    ).toBe(true);
    await s.ok('revoke_policy', {
      ruleId: named.rule.id,
      expectedVersion: named.rule.version,
      idempotencyKey: key(),
      confirm: true,
    });
    const flag = (await s.ok('read_feature_flags')).flags.find(
      (f: { flag: string }) => f.flag === 'cloud_ai.triage',
    );
    expect(flag.enabled).toBe(false);
    expect(env.db.get('SELECT 1 FROM feature_flags')).toBeDefined();
  });
});

describe('request_reconciliation', () => {
  it('needs confirm, like every other action with an effect', async () => {
    const env = createMcpEnv();
    const s = await env.session(env.owner);
    const created = await s.ok('create_mission', {
      ...MISSION,
      idempotencyKey: key(),
    });
    const reply = await s.call('request_reconciliation', {
      missionId: created.mission.id,
      idempotencyKey: key(),
    });
    expect(reply.isError).toBe(true);
    expect(reply.data.error.code).toBe('confirmation_required');
  });
});

describe('session lifetime', () => {
  const input = (principalId: string, now: Date) => ({
    workspaceId: 'ws_test',
    principalId,
    protocolVersion: '2025-06-18',
    clientName: null,
    now,
  });

  it('ends a session idle past the TTL, and keeps one that was used in time', () => {
    const db = openTestDatabase();
    const { principalId } = seedPrincipal(db, { kind: 'human' });
    const owner = { workspaceId: 'ws_test', principalId };
    const t0 = new Date('2026-04-01T00:00:00Z');
    const idle = openSession(db, input(principalId, t0));
    const active = openSession(db, input(principalId, t0));
    const justBefore = new Date(t0.getTime() + SESSION_IDLE_TTL_MS - 1);
    expect(findSession(db, active.id, owner, justBefore)).toBeDefined();
    const later = new Date(justBefore.getTime() + SESSION_IDLE_TTL_MS - 1);
    // Used at justBefore, so still inside the TTL. The idle one was never touched again.
    expect(findSession(db, active.id, owner, later)).toBeDefined();
    expect(findSession(db, idle.id, owner, later)).toBeUndefined();
    expect(
      db.get<{ closed_at: string | null }>(
        'SELECT closed_at FROM mcp_sessions WHERE id = ?',
        [idle.id],
      )?.closed_at,
    ).toBe(later.toISOString());
  });

  it('does not revive an expired session by using it again', () => {
    const db = openTestDatabase();
    const { principalId } = seedPrincipal(db, { kind: 'human' });
    const owner = { workspaceId: 'ws_test', principalId };
    const t0 = new Date('2026-04-01T00:00:00Z');
    const s = openSession(db, input(principalId, t0));
    const late = new Date(t0.getTime() + SESSION_IDLE_TTL_MS + 1);
    expect(findSession(db, s.id, owner, late)).toBeUndefined();
    expect(findSession(db, s.id, owner, late)).toBeUndefined();
    expect(closeSession(db, s.id, owner, late)).toBe(false);
  });

  it('purges closed sessions past their retention when a new one opens, and keeps recent ones', () => {
    const db = openTestDatabase();
    const { principalId } = seedPrincipal(db, { kind: 'human' });
    const owner = { workspaceId: 'ws_test', principalId };
    const t0 = new Date('2026-04-01T00:00:00Z');
    const old = openSession(db, input(principalId, t0));
    closeSession(db, old.id, owner, t0);
    const t1 = new Date(t0.getTime() + CLOSED_SESSION_RETENTION_MS - 1000);
    const recent = openSession(db, input(principalId, t1));
    closeSession(db, recent.id, owner, t1);
    openSession(
      db,
      input(
        principalId,
        new Date(t0.getTime() + CLOSED_SESSION_RETENTION_MS + 1000),
      ),
    );
    const ids = db
      .all<{ id: string }>('SELECT id FROM mcp_sessions')
      .map((r) => r.id);
    expect(ids).not.toContain(old.id);
    expect(ids).toContain(recent.id);
  });
});

describe('list_runs', () => {
  it('shows a runner principal only its own attempts, and a human all of them', async () => {
    const env = createMcpEnv();
    const owner = await env.session(env.owner);
    const other = env.seed('runner');
    const created = await owner.ok('create_mission', {
      ...MISSION,
      idempotencyKey: key(),
    });
    const missionId = created.mission.id as string;
    // Two packets, one attempt each, held by different runners.
    for (const [i, runner] of [
      env.principals.runner,
      other.principalId,
    ].entries()) {
      env.db.run(
        `INSERT INTO work_packets (workspace_id, id, mission_id, position, title, status, required, created_at, updated_at)
         VALUES ('ws_test', ?, ?, ?, 't', 'leased', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
        [`pkt_${i}`, missionId, i + 1],
      );
      env.db.run(
        `INSERT INTO execution_attempts (workspace_id, id, mission_id, packet_id, number, runner_id, status, dispatched_at)
         VALUES ('ws_test', ?, ?, ?, 1, ?, 'leased', '2026-01-01T00:00:0${i}Z')`,
        [`att_${i}`, missionId, `pkt_${i}`, runner],
      );
    }
    const asRunner = await env.session(env.runner);
    const mine = (await asRunner.ok('list_runs', {})).runs as Array<{
      id: string;
      runnerId: string;
    }>;
    expect(mine.map((r) => r.id)).toEqual(['att_0']);
    expect(mine.every((r) => r.runnerId === env.principals.runner)).toBe(true);
    // Naming another mission or status cannot widen it.
    expect(
      (await asRunner.ok('list_runs', { missionId, status: 'leased' })).runs,
    ).toHaveLength(1);
    expect((await owner.ok('list_runs', {})).runs).toHaveLength(2);
  });
});
