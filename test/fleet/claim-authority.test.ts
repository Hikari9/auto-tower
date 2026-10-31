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
    expect(String(answer.body.withheld)).toMatch(/^authority: /);
  });
});
