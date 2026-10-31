import { describe, expect, it, vi } from 'vitest';
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
    expect(reasons(resent)[0]).toMatch(
      /^authority: policy ref .* does not name a current rule/,
    );
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
    h.clock.advance(h.config.leaseTtlMs + 1_000);
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
    expect(answer.body.withheld).toMatch(
      /^authority: policy ref .* does not name a current rule/,
    );
    // Reconcile is not a claim: the refusal is returned, not recorded.
    expect(denials(h)).toHaveLength(0);
    expect(receipts(h)).toHaveLength(0);
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
      reason: expect.stringMatching(
        /^authority: policy ref .* does not name a current rule/,
      ),
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
    const missionId = h.db.all<{ mission_id: string }>(
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

describe('claim-time refusals: coverage of each record and hold', () => {
  it('records one row per refused attempt, distinct by attempt, under one policy version', async () => {
    const { h, policy } = setup();
    policy.createRule(
      h.ctx(),
      ruleInput({
        effect: 'deny',
        action: '*',
        resource: '*',
        scope: '*',
        grantee: { kind: null, principalId: null },
      }),
    );
    const runner = await h.runner();
    const claim = (await runner.claim()) as Claim;
    expect(claim.body.withheld).toHaveLength(2);
    const attempts = claim.body.withheld.map((w) => w.attemptId);
    const rows = denials(h);
    expect(rows.map((r) => r.detail.attemptId).sort()).toEqual(
      [...attempts].sort(),
    );
    expect(new Set(rows.map((r) => r.detail.policyVersion)).size).toBe(1);
    const deny = receipts(h);
    expect(deny.map((r) => r.resource).sort()).toEqual(
      attempts.map((a) => `attempt:${a}`).sort(),
    );
  });

  it('denies a human branch only when the deny rule names the authorizing principal', async () => {
    const { h, policy, cited, human } = setup();
    // Denies a principal other than the authorizer: the human branch must still be granted.
    policy.createRule(
      h.ctx(),
      ruleInput({
        effect: 'deny',
        action: '*',
        resource: '*',
        scope: 'env:prod',
        grantee: { kind: null, principalId: h.cos.actor.id },
      }),
    );
    const runner = await h.runner();
    const other = (await runner.claim()) as Claim;
    expect(packetsGranted(other)).toEqual(
      expect.arrayContaining([cited, human]),
    );
    expect(other.body.withheld).toEqual([]);

    // Denies the authorizer by id: the human branch is withheld.
    policy.createRule(
      h.ctx(),
      ruleInput({
        effect: 'deny',
        action: '*',
        resource: '*',
        scope: 'env:prod',
        grantee: { kind: null, principalId: h.owner.actor.id },
      }),
    );
    const own = (await runner.claim()) as Claim;
    expect(packetsGranted(own)).not.toContain(human);
    expect(reasons(own)).toHaveLength(1);
  });

  it('returns each mission only its own holds, and drops a hold once its offer is released', async () => {
    const { h, policy, human } = setup();
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
    const runner = await h.runner({ maxConcurrent: 10 });
    await runner.claim();
    const humanAttempt = denials(h).find((d) => d.detail.packetId === human)
      ?.detail.attemptId as string;
    const missionOf = (attemptId: string) =>
      h.db.all<{ mission_id: string }>(
        'SELECT mission_id FROM execution_attempts WHERE workspace_id = ? AND id = ?',
        [TEST_WORKSPACE, attemptId],
      )[0]?.mission_id as string;
    const firstMission = missionOf(humanAttempt);

    const other = h.mission([{ title: 'other', scope: ['env:prod'] }]);
    await runner.claim();
    const otherHolds = await h.call(
      h.owner.token,
      'GET',
      `/missions/${other.id}`,
    );
    expect(otherHolds.body.holds).toHaveLength(1);
    expect(otherHolds.body.holds[0].packetId).toBe(other.packetIds[0]);
    const firstHolds = await h.call(
      h.owner.token,
      'GET',
      `/missions/${firstMission}`,
    );
    expect(
      firstHolds.body.holds.map((x: { packetId: string }) => x.packetId),
    ).toEqual([human]);

    const released = await h.call(
      h.owner.token,
      'POST',
      `/runners/attempts/${humanAttempt}/release`,
      { reason: 'withdrawn by owner' },
    );
    expect(released.status).toBe(200);
    const after = await h.call(
      h.owner.token,
      'GET',
      `/missions/${firstMission}`,
    );
    expect(after.body.holds).toEqual([]);
  });

  it('keeps the latest reason and policy version for an attempt refused twice', async () => {
    const { h, policy, rule, human } = setup();
    policy.revokeRule(h.ctx(), rule.id, 1, 'withdrawn');
    const runner = await h.runner();
    const first = (await runner.claim()) as Claim;
    const attemptId = first.body.withheld.find((w) =>
      w.reason.includes('current rule'),
    )?.attemptId;
    policy.createRule(h.ctx(), ruleInput({ action: 'unrelated.check' }));
    await runner.claim();
    const rows = denials(h).filter((d) => d.detail.attemptId === attemptId);
    expect(rows).toHaveLength(2);
    const missionId = rows[0]?.detail.missionId;
    const res = await h.call(h.owner.token, 'GET', `/missions/${missionId}`);
    const holds = res.body.holds.filter(
      (x: { packetId: string }) => x.packetId !== human,
    );
    expect(holds).toHaveLength(1);
    expect(holds[0].policyVersion).toBe(rows[1]?.detail.policyVersion);
    expect(holds[0].reason).toBe(rows[1]?.detail.reason);
  });

  it('refuses a human packet whose scope the policy cannot check', async () => {
    const { h, policy } = setup();
    const wildcard = h.mission([{ title: 'wild', scope: ['env:*'] }]);
    const traversal = h.mission([{ title: 'trav', scope: ['../x'] }]);
    policy.createRule(
      h.ctx(),
      ruleInput({
        effect: 'deny',
        action: '*',
        resource: '*',
        scope: '*',
        grantee: { kind: null, principalId: null },
      }),
    );
    const runner = await h.runner({ maxConcurrent: 10 });
    const claim = (await runner.claim()) as Claim;
    const reasonFor = (packetId: string) =>
      denials(h).find((d) => d.detail.packetId === packetId)?.detail.reason;
    expect(reasonFor(wildcard.packetIds[0] ?? '')).toMatch(
      /^authority: packet .* declares a scope a deny rule cannot be checked against/,
    );
    expect(reasonFor(traversal.packetIds[0] ?? '')).toMatch(
      /^authority: packet .* declares a scope/,
    );
    expect(packetsGranted(claim)).toEqual([]);
  });

  it('does not let a packet with no execution scope be authorized, so no runner can claim one', () => {
    const { h } = setup();
    expect(() => h.mission([{ title: 'empty', scope: [] }])).toThrow(
      /declares no execution scope/,
    );
  });

  it('refuses with an audit row and no receipt when the authorizing principal row is gone', async () => {
    const { h, cited } = setup();
    h.db.run('PRAGMA foreign_keys = OFF');
    h.db.run('DELETE FROM principals WHERE id = ? AND workspace_id = ?', [
      h.cos.actor.id,
      TEST_WORKSPACE,
    ]);
    const runner = await h.runner();
    const claim = (await runner.claim()) as Claim;
    expect(claim.status).toBe(200);
    expect(packetsGranted(claim)).not.toContain(cited);
    expect(reasons(claim)).toEqual([
      expect.stringMatching(
        /^authority: the authorizing principal .* is not in this workspace/,
      ),
    ]);
    const rows = denials(h);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail.packetId).toBe(cited);
    expect(receipts(h)).toHaveLength(0);
  });
});

describe('claim-time refusals: resource, principal state, live holds and durability', () => {
  it('refuses a human packet under a deny rule whose resource is concrete', async () => {
    const { h, policy, human } = setup();
    policy.createRule(
      h.ctx(),
      ruleInput({
        effect: 'deny',
        action: '*',
        resource: 'repo:app',
        scope: 'env:prod',
        grantee: { kind: null, principalId: null },
      }),
    );
    const runner = await h.runner({ maxConcurrent: 10 });
    const claim = (await runner.claim()) as Claim;
    expect(packetsGranted(claim)).not.toContain(human);
    expect(reasons(claim)[0]).toMatch(/^authority: denied by rule/);
  });

  it('refuses a human packet whose authorizer is disabled', async () => {
    const { h, human } = setup();
    const runner = await h.runner({ maxConcurrent: 10 });
    h.db.run(
      'UPDATE principals SET disabled_at = ? WHERE id = ? AND workspace_id = ?',
      ['2026-01-01T00:00:00.000Z', h.owner.actor.id, TEST_WORKSPACE],
    );
    const claim = (await runner.claim()) as Claim;
    expect(packetsGranted(claim)).not.toContain(human);
    expect(reasons(claim)[0]).toBe('authority: the principal is disabled');
    expect(denials(h).map((d) => d.detail.packetId)).toEqual([human]);
  });

  it('refuses a human packet whose authorizer is no longer in the workspace, and records no receipt for it', async () => {
    const { h, human } = setup();
    const runner = await h.runner({ maxConcurrent: 10 });
    h.db.run('PRAGMA foreign_keys = OFF');
    h.db.run('DELETE FROM principals WHERE id = ? AND workspace_id = ?', [
      h.owner.actor.id,
      TEST_WORKSPACE,
    ]);
    const claim = (await runner.claim()) as Claim;
    expect(packetsGranted(claim)).not.toContain(human);
    expect(reasons(claim)).toContainEqual(
      expect.stringMatching(
        /^authority: the authorizing principal .* is not in this workspace/,
      ),
    );
    expect(denials(h).map((d) => d.detail.packetId)).toContain(human);
    // The authorizer has no row to attribute a receipt to, so the refusal is audited without one.
    expect(receipts(h)).toHaveLength(0);
  });

  it('shows a hold only while its refusal stands, with no claim needed to clear it', async () => {
    const { h, policy, human } = setup();
    const deny = policy.createRule(
      h.ctx(),
      ruleInput({
        effect: 'deny',
        action: '*',
        resource: '*',
        scope: 'env:prod',
        grantee: { kind: null, principalId: null },
      }),
    ).rule;
    const runner = await h.runner({ maxConcurrent: 10 });
    await runner.claim();
    const humanRow = denials(h).find((d) => d.detail.packetId === human);
    const attemptId = humanRow?.detail.attemptId as string;
    const missionId = humanRow?.detail.missionId as string;
    const held = await h.call(h.owner.token, 'GET', `/missions/${missionId}`);
    expect(held.body.holds).toEqual([
      expect.objectContaining({ attemptId, packetId: human }),
    ]);
    policy.revokeRule(h.ctx(), deny.id, 1, 'lifted');
    const read = await h.call(h.owner.token, 'GET', `/missions/${missionId}`);
    expect(read.body.holds).toEqual([]);
  });

  it('holds an unconfirmed lease whose resend is refused, and clears the hold once resent', async () => {
    const { h, policy, cited } = setup();
    const runner = await h.runner({ maxConcurrent: 10 });
    const first = (await runner.claim()) as Claim;
    expect(packetsGranted(first)).toContain(cited);
    const granted = first.body.assignments.find((a) => a.packetId === cited);
    const missionId = (granted as unknown as { missionId: string }).missionId;
    const deny = policy.createRule(
      h.ctx(),
      ruleInput({
        effect: 'deny',
        grantee: { kind: null, principalId: null },
        scope: 'env:staging',
      }),
    ).rule;
    // The runner has not confirmed the lease, so the next poll tries to resend it, and is refused.
    const refused = (await runner.claim()) as Claim;
    expect(packetsGranted(refused)).not.toContain(cited);
    expect(reasons(refused)).toHaveLength(1);
    // The runner never confirmed the lease, so the refused resend is a hold on the branch.
    const whileHeld = await h.call(
      h.owner.token,
      'GET',
      `/missions/${missionId}`,
    );
    expect(
      whileHeld.body.holds.map((x: { packetId: string }) => x.packetId),
    ).toEqual([cited]);
    policy.revokeRule(h.ctx(), deny.id, 1, 'lifted');
    const resent = (await runner.claim()) as Claim;
    expect(packetsGranted(resent)).toContain(cited);
    const read = await h.call(h.owner.token, 'GET', `/missions/${missionId}`);
    expect(read.body.holds).toEqual([]);
  });

  it('keeps the refusal on record when the claim that found it rolls back', async () => {
    const { h, policy, rule, cited } = setup();
    const runner = await h.runner({ maxConcurrent: 10 });
    // Both branches are granted, so the cited one is a held lease the next poll resends.
    expect(packetsGranted((await runner.claim()) as Claim)).toContain(cited);
    policy.revokeRule(h.ctx(), rule.id, 1, 'withdrawn');
    // A new offer is granted after the resend is refused, and its lease write fails, so the claim
    // rolls back after the refusal was collected.
    h.mission([{ title: 'fresh', scope: ['env:fresh'] }]);
    const real = h.db.run.bind(h.db);
    const spy = vi.spyOn(h.db, 'run').mockImplementation((...args) => {
      if (args[0].includes('INSERT INTO runner_leases')) {
        throw new Error('injected lease write failure');
      }
      return real(...args);
    });
    try {
      const res = await runner.claim();
      expect(res.status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    expect(denials(h).map((d) => d.detail.packetId)).toEqual([cited]);
    expect(receipts(h)).toHaveLength(1);
  });
});

describe('claim-time authority: deny scope, effect, grantee and disabled coverage', () => {
  it('does not apply a deny rule that names another mission', async () => {
    const { h, policy, human } = setup();
    policy.createRule(
      h.ctx(),
      ruleInput({
        effect: 'deny',
        action: '*',
        resource: '*',
        scope: 'env:prod',
        grantee: { kind: null, principalId: null },
        limits: { maxAmount: null, missionIds: ['msn_someone_else'] },
      }),
    );
    const runner = await h.runner({ maxConcurrent: 10 });
    const claim = (await runner.claim()) as Claim;
    expect(packetsGranted(claim)).toContain(human);
    expect(denials(h)).toHaveLength(0);
  });

  it('does not apply a deny rule whose concrete action is not the claim action', async () => {
    const { h, policy, human } = setup();
    policy.createRule(
      h.ctx(),
      ruleInput({
        effect: 'deny',
        action: 'deploy.staging',
        resource: '*',
        scope: 'env:prod',
        grantee: { kind: null, principalId: null },
      }),
    );
    const runner = await h.runner({ maxConcurrent: 10 });
    const claim = (await runner.claim()) as Claim;
    expect(packetsGranted(claim)).toContain(human);
  });

  it('does not treat an allow rule as a refusal for a human packet', async () => {
    const { h, policy, human } = setup();
    policy.createRule(
      h.ctx(),
      ruleInput({
        effect: 'allow',
        action: '*',
        resource: '*',
        scope: 'env:prod',
        grantee: { kind: 'human', principalId: null },
        maxRisk: 'high',
      }),
    );
    const runner = await h.runner({ maxConcurrent: 10 });
    const claim = (await runner.claim()) as Claim;
    expect(packetsGranted(claim)).toContain(human);
    expect(denials(h)).toHaveLength(0);
  });

  it('does not apply a deny rule granted only to a chief of staff to a human packet', async () => {
    const { h, policy, human } = setup();
    policy.createRule(
      h.ctx(),
      ruleInput({
        effect: 'deny',
        action: '*',
        resource: '*',
        scope: 'env:prod',
        grantee: { kind: 'chief_of_staff', principalId: null },
      }),
    );
    const runner = await h.runner({ maxConcurrent: 10 });
    const claim = (await runner.claim()) as Claim;
    expect(packetsGranted(claim)).toContain(human);
  });

  it('refuses a cited branch whose chief of staff is disabled', async () => {
    const { h, cited } = setup();
    const runner = await h.runner({ maxConcurrent: 10 });
    h.db.run(
      'UPDATE principals SET disabled_at = ? WHERE id = ? AND workspace_id = ?',
      ['2026-01-01T00:00:00.000Z', h.cos.actor.id, TEST_WORKSPACE],
    );
    const claim = (await runner.claim()) as Claim;
    expect(packetsGranted(claim)).not.toContain(cited);
    expect(reasons(claim)).toEqual(['authority: the principal is disabled']);
  });
});

describe('claim-time authority: scope spelling', () => {
  it.each([
    ['trailing zero-width space', 'env:prod\u200b'],
    ['trailing no-break space', 'env:prod\u00a0'],
    ['trailing soft hyphen', 'env:prod\u00ad'],
    ['trailing zero-width joiner', 'env:prod\u200d'],
    ['internal space', 'env:my prod'],
    ['uppercase', 'ENV:PROD'],
    ['cyrillic homoglyph', 'env:\u0440rod'],
  ])('refuses a human packet whose scope has a %s', async (_label, scope) => {
    const { h, policy } = setup();
    const padded = h.mission([{ title: 'hidden', scope: [scope] }]);
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
    const runner = await h.runner({
      maxConcurrent: 10,
      capabilities: ['docker'],
    });
    const claim = (await runner.claim()) as Claim;
    expect(packetsGranted(claim)).not.toContain(padded.packetIds[0]);
    expect(reasons(claim)).toContainEqual(
      expect.stringMatching(
        /declares a scope a deny rule cannot be checked against/,
      ),
    );
  });

  it('refuses a human packet whose scope has padding, which a literal deny rule would miss', async () => {
    const { h, policy } = setup();
    const padded = h.mission([{ title: 'padded', scope: ['env:prod '] }]);
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
    const runner = await h.runner({ maxConcurrent: 10 });
    const claim = (await runner.claim()) as Claim;
    expect(packetsGranted(claim)).not.toContain(padded.packetIds[0]);
    expect(reasons(claim)).toContainEqual(
      expect.stringMatching(
        /^authority: packet .* declares a scope a deny rule cannot be checked against/,
      ),
    );
  });
});

describe('claim-time authority: a failed refusal write does not change the claim', () => {
  it('still grants the claim when recording a refusal fails', async () => {
    const { h, policy, rule, human } = setup();
    policy.revokeRule(h.ctx(), rule.id, 1, 'withdrawn');
    const runner = await h.runner({ maxConcurrent: 10 });
    const real = h.db.run.bind(h.db);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const spy = vi.spyOn(h.db, 'run').mockImplementation((...args) => {
      if (args[0].includes('INSERT INTO policy_receipts')) {
        throw new Error('injected receipt failure');
      }
      return real(...args);
    });
    try {
      const claim = (await runner.claim()) as Claim;
      expect(claim.status).toBe(200);
      expect(packetsGranted(claim)).toContain(human);
      expect(errors).toHaveBeenCalledWith('claim refusals not recorded: Error');
    } finally {
      spy.mockRestore();
      errors.mockRestore();
    }
    // The failed write rolled back with its transaction, so no refusal is on record.
    expect(denials(h)).toHaveLength(0);
  });
});

describe('claim-time authority: a deny rule in another spelling of the same repository', () => {
  it.each([
    ['capitalised', 'repo:Foo'],
    ['git suffix', 'repo:foo.git'],
    ['trailing slash', 'repo:foo/'],
  ])(
    'refuses a human packet on repo:foo under a deny rule spelled %s',
    async (_label, ruleScope) => {
      const { h, policy } = setup();
      const repo = h.mission([{ title: 'repo', scope: ['repo:foo'] }]);
      policy.createRule(
        h.ctx(),
        ruleInput({
          effect: 'deny',
          action: '*',
          resource: '*',
          scope: ruleScope,
          grantee: { kind: null, principalId: null },
        }),
      );
      const runner = await h.runner({ maxConcurrent: 10 });
      const claim = (await runner.claim()) as Claim;
      expect(packetsGranted(claim)).not.toContain(repo.packetIds[0]);
      expect(reasons(claim)).toContainEqual(
        expect.stringMatching(/^authority: denied by rule/),
      );
    },
  );
});
