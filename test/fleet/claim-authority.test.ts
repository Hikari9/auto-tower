import { describe, expect, it } from 'vitest';
import { createPolicyService } from '../../src/policy/service.js';
import { mission } from '../core/helpers.js';
import { TEST_WORKSPACE } from '../helpers/tower.js';
import { ruleInput } from '../policy/helpers.js';
import { createFleetHarness } from './helpers.js';

/**
 * Two packets in one mission. A chief of staff authorizes `cited` under a policy rule. A human
 * authorizes `human` with no citation. Each test changes the rule after authorization and polls.
 */
function setup(lifetimeMs?: number) {
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

  const addPacket = (title: string, scope: string[]): string => {
    state = h.core.missions.addPacket(h.ctx(), state.id, state.version, {
      title,
      instructions: 'do it',
      scope,
      required: true,
      dependsOn: [],
    }).mission;
    return state.packets[state.packets.length - 1]?.id as string;
  };
  const cited = addPacket('cited', ['env:staging']);
  const human = addPacket('human', ['env:prod']);

  const expiresAt =
    lifetimeMs === undefined
      ? null
      : new Date(h.clock.now().getTime() + lifetimeMs).toISOString();
  const rule = policy.createRule(h.ctx(), ruleInput({ expiresAt })).rule;
  const ref = `policy:v${policy.policyVersion(TEST_WORKSPACE)}:rule:${rule.id}@1`;
  state = h.core.missions.authorizePacket(
    h.ctx({ actor: h.cos.actor }),
    state.id,
    state.version,
    cited,
    [ref],
  ).mission;
  h.core.missions.authorizePacket(h.ctx(), state.id, state.version, human, []);

  return { h, policy, rule, cited, human };
}

type Claim = {
  status: number;
  body: {
    assignments: Array<{ packetId: string }>;
    withheld: Array<{ attemptId: string; reason: string }>;
  };
};

const packetsGranted = (claim: Claim) =>
  claim.body.assignments.map((a) => a.packetId);
const reasons = (claim: Claim) => claim.body.withheld.map((w) => w.reason);

describe('claim-time authority re-check', () => {
  it('grants both branches while the cited rule is current', async () => {
    const { h, cited, human } = setup();
    const runner = await h.runner();
    const claim = (await runner.claim()) as Claim;
    expect(claim.status).toBe(200);
    expect(packetsGranted(claim).sort()).toEqual([cited, human].sort());
    expect(claim.body.withheld).toEqual([]);
  });

  it('withholds only the cited branch once its rule is revoked', async () => {
    const { h, policy, rule, human } = setup();
    policy.revokeRule(h.ctx(), rule.id, 1, 'withdrawn');
    const runner = await h.runner();
    const claim = (await runner.claim()) as Claim;
    expect(claim.status).toBe(200);
    expect(packetsGranted(claim)).toEqual([human]);
    expect(reasons(claim)).toHaveLength(1);
    // Revoking bumps the rule version, so the ref cited at @1 no longer names a current rule.
    expect(reasons(claim)[0]).toMatch(
      /^authority: policy ref .* does not name a current rule/,
    );
  });

  it('withholds the cited branch once its rule has expired', async () => {
    const { h, human } = setup(1_000);
    h.clock.advance(2_000);
    const runner = await h.runner();
    const claim = (await runner.claim()) as Claim;
    expect(claim.status).toBe(200);
    expect(packetsGranted(claim)).toEqual([human]);
    expect(reasons(claim)[0]).toMatch(/^authority: .*expired/);
  });

  it('withholds the cited branch when a deny rule covers it after authorization', async () => {
    const { h, policy, human } = setup();
    policy.createRule(
      h.ctx(),
      ruleInput({ effect: 'deny', grantee: { kind: null, principalId: null } }),
    );
    const runner = await h.runner();
    const claim = (await runner.claim()) as Claim;
    expect(claim.status).toBe(200);
    expect(packetsGranted(claim)).toEqual([human]);
    expect(reasons(claim)).toHaveLength(1);
    expect(reasons(claim)[0]).toMatch(/^authority: .*denied by rule/);
  });

  it('re-checks an unconfirmed lease before it is resent', async () => {
    const { h, policy, rule, cited, human } = setup();
    const runner = await h.runner();
    const first = (await runner.claim()) as Claim;
    expect(packetsGranted(first).sort()).toEqual([cited, human].sort());
    // The runner never confirms the leases, so the next poll takes the resend path.
    policy.revokeRule(h.ctx(), rule.id, 1, 'withdrawn');
    const resent = (await runner.claim()) as Claim;
    expect(packetsGranted(resent)).toEqual([human]);
    expect(reasons(resent)).toHaveLength(1);
    expect(reasons(resent)[0]).toMatch(/^authority: /);
  });

  it('withholds the cited branch on reconcile after its rule is revoked, and does not reissue its fence', async () => {
    const { h, policy, rule, cited } = setup();
    const runner = await h.runner();
    const first = (await runner.claim()) as {
      body: {
        assignments: Array<{
          packetId: string;
          leaseId: string;
          fence: number;
        }>;
      };
    };
    const granted = first.body.assignments.find((a) => a.packetId === cited);
    expect(granted).toBeDefined();
    // The runner goes quiet past the lease TTL, so the lease moves to recovery.
    h.clock.advance(61_000);
    policy.revokeRule(h.ctx(), rule.id, 1, 'withdrawn');
    const answer = await runner.reconcile(
      granted?.leaseId ?? '',
      granted?.fence ?? 0,
    );
    expect(answer.status).toBe(200);
    expect(answer.body.assignment).toBeNull();
    // Refused, not re-issued: the lease keeps its original fence and stays in recovery.
    expect(answer.body.lease.fence).toBe(granted?.fence);
    expect(answer.body.lease.status).toBe('recovering');
    expect(answer.body.withheld).toMatch(/^authority: /);
  });
});

interface DenialRow {
  runner_id: string | null;
  actor_id: string | null;
  detail_json: string;
}

interface ReceiptRow {
  principal_id: string;
  action: string;
  resource: string;
  effect: string;
  code: string;
  reason: string;
  policy_version: number;
}

/** Claim-time refusals as the audit holds them, with the detail parsed. */
function denials(h: ReturnType<typeof setup>['h']) {
  return h.db
    .all<DenialRow>(
      "SELECT runner_id, actor_id, detail_json FROM fleet_audit WHERE kind = 'claim.authority_denied' ORDER BY seq",
    )
    .map((row) => ({ ...row, detail: JSON.parse(row.detail_json) }));
}

function receipts(h: ReturnType<typeof setup>['h']): ReceiptRow[] {
  return h.db.all<ReceiptRow>(
    "SELECT principal_id, action, resource, effect, code, reason, policy_version FROM policy_receipts WHERE code = 'claim_authority_denied' ORDER BY seq",
  );
}

describe('a claim-time authority refusal is durable and visible', () => {
  it('writes one audit row and one deny receipt per attempt and policy version, however often it polls', async () => {
    const { h, policy, rule, cited } = setup();
    policy.revokeRule(h.ctx(), rule.id, 1, 'withdrawn');
    const runner = await h.runner();
    const first = (await runner.claim()) as Claim;
    const attemptId = first.body.withheld[0]?.attemptId ?? '';
    await runner.claim();
    await runner.claim();

    const rows = denials(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.runner_id).toBe(runner.id);
    expect(rows[0]?.detail).toEqual({
      attemptId,
      packetId: cited,
      missionId: expect.any(String),
      policyVersion: expect.any(Number),
      reason: expect.stringMatching(/^authority: policy ref .* does not name a current rule/),
    });

    const deny = receipts(h);
    expect(deny).toHaveLength(1);
    expect(deny[0]).toMatchObject({
      principal_id: h.cos.actor.id,
      action: 'packet.claim',
      resource: `attempt:${attemptId}`,
      effect: 'deny',
      code: 'claim_authority_denied',
      policy_version: rows[0]?.detail.policyVersion,
    });
  });

  it('records again only when the policy version moves', async () => {
    const { h, policy, rule } = setup();
    policy.revokeRule(h.ctx(), rule.id, 1, 'withdrawn');
    const runner = await h.runner();
    await runner.claim();
    expect(denials(h)).toHaveLength(1);
    policy.createRule(h.ctx(), ruleInput({ action: 'unrelated.check' }));
    await runner.claim();
    const rows = denials(h);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.detail.policyVersion).toBeGreaterThan(
      rows[0]?.detail.policyVersion,
    );
    expect(receipts(h)).toHaveLength(2);
  });

  it('shows the open hold on the mission read, and clears it once a later claim grants the branch', async () => {
    const { h, cited, policy } = setup();
    const deny = policy.createRule(
      h.ctx(),
      ruleInput({
        effect: 'deny',
        grantee: { kind: null, principalId: null },
      }),
    ).rule;
    const runner = await h.runner();
    const claim = (await runner.claim()) as Claim;
    const attemptId = claim.body.withheld[0]?.attemptId;
    const missionId = h.db
      .all<{ mission_id: string }>(
        'SELECT mission_id FROM execution_attempts WHERE workspace_id = ? AND id = ?',
        [TEST_WORKSPACE, attemptId ?? ''],
      )[0]?.mission_id;

    const held = await h.call(h.owner.token, 'GET', `/missions/${missionId}`);
    expect(held.status).toBe(200);
    expect(held.body.holds).toEqual([
      {
        attemptId,
        packetId: cited,
        reason: expect.stringMatching(/^authority: .*denied by rule/),
        policyVersion: expect.any(Number),
        at: expect.any(String),
      },
    ]);

    policy.revokeRule(h.ctx(), deny.id, 1, 'lifted');
    const granted = (await runner.claim()) as Claim;
    expect(packetsGranted(granted)).toContain(cited);
    const clear = await h.call(h.owner.token, 'GET', `/missions/${missionId}`);
    expect(clear.body.holds).toEqual([]);
  });
});

describe('a human-authorized packet is re-checked against deny rules at claim', () => {
  it('withholds only the human branch when a deny rule added after authorization covers it', async () => {
    const { h, policy, cited, human } = setup();
    policy.createRule(
      h.ctx(),
      ruleInput({
        effect: 'deny',
        action: '*',
        resource: '*',
        scope: 'env:prod',
        grantee: { kind: null, principalId: null },
      }),
    );
    const runner = await h.runner();
    const claim = (await runner.claim()) as Claim;
    expect(claim.status).toBe(200);
    expect(packetsGranted(claim)).toEqual([cited]);
    expect(reasons(claim)).toHaveLength(1);
    expect(reasons(claim)[0]).toMatch(/^authority: .*denied by rule/);

    const rows = denials(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor_id).toBe(h.owner.actor.id);
    expect(rows[0]?.detail.packetId).toBe(human);
    const deny = receipts(h);
    expect(deny).toHaveLength(1);
    expect(deny[0]).toMatchObject({
      principal_id: h.owner.actor.id,
      action: 'packet.claim',
      code: 'claim_authority_denied',
    });
  });

  it('still dispatches the human branch when the deny rule covers another scope', async () => {
    const { h, policy, human } = setup();
    policy.createRule(
      h.ctx(),
      ruleInput({
        effect: 'deny',
        action: '*',
        resource: '*',
        scope: 'env:staging',
        grantee: { kind: null, principalId: null },
      }),
    );
    const runner = await h.runner();
    const claim = (await runner.claim()) as Claim;
    expect(packetsGranted(claim)).toContain(human);
    expect(denials(h).map((row) => row.detail.packetId)).not.toContain(human);
  });
});
