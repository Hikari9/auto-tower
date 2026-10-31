import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AUTHORITY_HOLDS_SQL,
  authorityHoldsFor,
  CLAIM_REFUSAL_SEEN_SQL,
  withoutRuleIds,
} from '../../src/fleet/broker.js';
import {
  CLAIM_REFUSAL_WRITE_FAILED,
  healthReport,
} from '../../src/ops/index.js';
import { createPolicyService } from '../../src/policy/service.js';
import { mission } from '../core/helpers.js';
import { seedPrincipal, TEST_WORKSPACE } from '../helpers/tower.js';
import { ruleInput } from '../policy/helpers.js';
import { createFleetHarness } from './helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

/** One packet a chief of staff authorized under a rule, then the rule is revoked. */
async function revoked() {
  const h = createFleetHarness();
  const policy = createPolicyService({ db: h.db, clock: h.clock.now });
  let state = h.core.missions.createMission(h.ctx(), mission()).mission;
  state = h.core.missions.transitionMission(
    h.ctx(),
    state.id,
    state.version,
    'ready',
    null,
  ).mission;
  state = h.core.missions.addPacket(h.ctx(), state.id, state.version, {
    title: 'cited',
    instructions: 'do',
    scope: ['env:staging'],
    required: true,
    dependsOn: [],
  }).mission;
  const rule = policy.createRule(h.ctx(), ruleInput()).rule;
  const ref = `policy:v${policy.policyVersion(TEST_WORKSPACE)}:rule:${rule.id}@1`;
  h.core.missions.authorizePacket(
    h.ctx({ actor: h.cos.actor }),
    state.id,
    state.version,
    state.packets[0]?.id as string,
    [ref],
  );
  policy.revokeRule(h.ctx(), rule.id, 1, 'withdrawn');
  const runner = await h.runner();
  const claim = await runner.claim();
  return { h, rule, runner, claim, missionId: state.id };
}

describe('mission holds name rules only to a person or a chief of staff', () => {
  it('shows the rule id to a human and a chief of staff, and not to a runner or a provider', async () => {
    const { h, rule, missionId } = await revoked();
    const current = h.getMission(missionId);
    const read = (viewer: Parameters<typeof authorityHoldsFor>[4]) =>
      authorityHoldsFor(h.db, h.clock.now, TEST_WORKSPACE, current, viewer);
    for (const viewer of ['human', 'chief_of_staff'] as const) {
      expect(read(viewer)[0]?.reason).toContain(rule.id);
    }
    for (const viewer of ['runner', 'provider_adapter'] as const) {
      const holds = read(viewer);
      expect(holds).toHaveLength(1);
      expect(holds[0]?.reason).toMatch(/^authority: /);
      expect(holds[0]?.reason).not.toContain(rule.id);
      expect(holds[0]?.reason).not.toMatch(/policy:v\d+:rule:/);
    }
  });

  it('shows the rule id over HTTP to a person, and not to a runner token', async () => {
    const { h, rule, missionId } = await revoked();
    // A runner-kind token that may read missions, as a runner principal can be given.
    const reader = seedPrincipal(h.db, { kind: 'runner', name: 'reader' });
    const asRunner = await h.call(
      reader.token,
      'GET',
      `/missions/${missionId}`,
    );
    expect(asRunner.status).toBe(200);
    expect(asRunner.body.holds).toHaveLength(1);
    expect(JSON.stringify(asRunner.body.holds)).not.toContain(rule.id);
    const asOwner = await h.call(
      h.owner.token,
      'GET',
      `/missions/${missionId}`,
    );
    expect(asOwner.body.holds[0].reason).toContain(rule.id);
    const asCos = await h.call(h.cos.token, 'GET', `/missions/${missionId}`);
    expect(asCos.body.holds[0].reason).toContain(rule.id);
  });

  it('keeps the rule id out of what a polling runner is told is withheld', async () => {
    const { rule, claim } = await revoked();
    expect(claim.body.withheld).toHaveLength(1);
    expect(JSON.stringify(claim.body)).not.toContain(rule.id);
    expect(claim.body.withheld[0].reason).toMatch(
      /does not name a current rule/,
    );
  });

  it('removes ref and bare rule id spellings, and leaves other text alone', () => {
    expect(
      withoutRuleIds('policy ref policy:v3:rule:rul_abc-1_Z@2 is bad'),
    ).toBe('policy ref a policy rule is bad');
    expect(withoutRuleIds('denied by rule rul_deadbeef for scope repo:x')).toBe(
      'denied by rule a rule for scope repo:x',
    );
    expect(withoutRuleIds('mission is paused')).toBe('mission is paused');
  });
});

describe('claim refusals are found through an index, not a scan of the workspace audit', () => {
  const plan = (
    h: ReturnType<typeof createFleetHarness>,
    sql: string,
    params: unknown[],
  ) =>
    h.db
      .all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, params as never)
      .map((r) => r.detail)
      .join('\n');

  it('searches the attempt index for the dedupe check', () => {
    const h = createFleetHarness();
    expect(plan(h, CLAIM_REFUSAL_SEEN_SQL, ['ws', 'att', 1])).toMatch(
      /fleet_audit_claim_attempt_idx/,
    );
    expect(plan(h, CLAIM_REFUSAL_SEEN_SQL, ['ws', 'att', 1])).not.toMatch(
      /SCAN (f|fleet_audit)\b/,
    );
  });

  it('searches the mission index for the holds lookup', () => {
    const h = createFleetHarness();
    const text = plan(h, AUTHORITY_HOLDS_SQL, ['ws', 'msn']);
    expect(text).toMatch(/fleet_audit_claim_mission_idx/);
    expect(text).not.toMatch(/SCAN f\b/);
  });
});

describe('a claim refusal that cannot be recorded shows up in health', () => {
  function breakRefusalWrites(h: ReturnType<typeof createFleetHarness>) {
    h.db.exec(`CREATE TRIGGER t9_block BEFORE INSERT ON fleet_audit
      WHEN NEW.kind = 'claim.authority_denied'
      BEGIN SELECT RAISE(ABORT, 'disk on fire'); END;`);
  }

  it('raises a warning with an action, keeps refusing the runner, and clears once a refusal is written', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = createFleetHarness();
    const policy = createPolicyService({ db: h.db, clock: h.clock.now });
    let state = h.core.missions.createMission(h.ctx(), mission()).mission;
    state = h.core.missions.transitionMission(
      h.ctx(),
      state.id,
      state.version,
      'ready',
      null,
    ).mission;
    state = h.core.missions.addPacket(h.ctx(), state.id, state.version, {
      title: 'cited',
      instructions: 'do',
      scope: ['env:staging'],
      required: true,
      dependsOn: [],
    }).mission;
    const rule = policy.createRule(h.ctx(), ruleInput()).rule;
    const ref = `policy:v${policy.policyVersion(TEST_WORKSPACE)}:rule:${rule.id}@1`;
    h.core.missions.authorizePacket(
      h.ctx({ actor: h.cos.actor }),
      state.id,
      state.version,
      state.packets[0]?.id as string,
      [ref],
    );
    policy.revokeRule(h.ctx(), rule.id, 1, 'withdrawn');
    const runner = await h.runner();

    breakRefusalWrites(h);
    const claim = await runner.claim();
    expect(claim.status).toBe(200);
    expect(claim.body.assignments).toEqual([]);
    expect(claim.body.withheld).toHaveLength(1);
    const report = healthReport(h.db, TEST_WORKSPACE);
    expect(report.status).toBe('degraded');
    const signal = report.signals.find(
      (s) => s.code === CLAIM_REFUSAL_WRITE_FAILED,
    );
    expect(signal).toMatchObject({ severity: 'warning', count: 1 });
    expect(signal?.action).toMatch(/database health/);
    // The error text of the failed write never reaches the log or the signal.
    expect(JSON.stringify(quiet.mock.calls)).not.toContain('disk on fire');
    expect(signal?.message).not.toContain('disk on fire');

    await runner.claim();
    expect(healthReport(h.db, TEST_WORKSPACE).signals[0]?.count).toBe(2);

    h.db.exec('DROP TRIGGER t9_block');
    await runner.claim();
    expect(healthReport(h.db, TEST_WORKSPACE).signals).toEqual([]);
    expect(
      h.db.all(
        "SELECT seq FROM fleet_audit WHERE kind = 'claim.authority_denied'",
      ),
    ).toHaveLength(1);
  });
});
