import { describe, expect, it } from 'vitest';
import { createIssueApi, type IssueApi } from '../issues/helpers.js';
import { missionWith } from '../policy/helpers.js';
import { key, McpClient } from './helpers.js';

function clients(api: IssueApi) {
  const make = async (token: string) => {
    const c = new McpClient((path, init) => api.raw(path, init), token);
    await c.initialize();
    return c;
  };
  return { owner: make(api.owner), cos: make(api.cos) };
}

/** A mission whose base packet covers src/*, plus follow-ups waiting for authorization. */
function withFollowUps(api: IssueApi, count = 2) {
  const m = missionWith(api.h, [
    { title: 'base', scope: ['src/*'], authorized: true },
    ...Array.from({ length: count }, (_, i) => ({
      title: `follow-up ${i}`,
      scope: [`infra/${['terraform', 'network', 'dns'][i]}`],
    })),
  ]);
  return { ...m, followUps: m.ids.slice(1) };
}

const expansionFor = (missionId: string, packetId: string, extra = {}) => ({
  missionId,
  packetId,
  action: 'scope.extend',
  resource: 'repo:app',
  scope: 'infra/terraform',
  risk: 'low',
  question: 'May this reach into infra?',
  idempotencyKey: key('exp'),
  ...extra,
});

const GRANT = {
  action: 'scope.extend',
  resource: 'repo:app',
  scope: 'infra/*',
  maxRisk: 'medium',
  grantee: { kind: 'chief_of_staff' },
};

describe('a chief of staff approves expansion only under an applicable grant', () => {
  it('goes to a person with no grant, is approved under a grant, and is blocked again after revocation', async () => {
    const api = createIssueApi();
    const { owner: ownerP, cos: cosP } = clients(api);
    const owner = await ownerP;
    const cos = await cosP;
    const { driver, followUps } = withFollowUps(api, 2);
    const [first, second] = followUps as [string, string];

    const asked = await cos.ok(
      'request_expansion',
      expansionFor(driver.id, first),
    );
    expect(asked).toMatchObject({ tier: 3, outcome: 'decision_required' });
    expect(asked.decision.requiredAuthority).toBe('human');
    expect(
      driver.refresh().packets.find((p) => p.id === first)?.authorization,
    ).toBeNull();

    const grant = await owner.ok('grant_policy', {
      ...GRANT,
      idempotencyKey: key('grant'),
      confirm: true,
    });
    const approved = await cos.ok(
      'request_expansion',
      expansionFor(driver.id, first, { idempotencyKey: key('exp') }),
    );
    expect(approved).toMatchObject({ tier: 2, outcome: 'approved' });
    const authorization = driver
      .refresh()
      .packets.find((p) => p.id === first)?.authorization;
    expect(authorization?.by).toBe(api.h.cos.id);
    expect(authorization?.policyRefs).toEqual([
      `policy:v${grant.policyVersion}:rule:${grant.rule.id}@${grant.rule.version}`,
    ]);

    await owner.ok('revoke_policy', {
      ruleId: grant.rule.id,
      expectedVersion: grant.rule.version,
      reason: 'done',
      idempotencyKey: key('revoke'),
      confirm: true,
    });
    const after = await cos.ok(
      'request_expansion',
      expansionFor(driver.id, second, {
        scope: 'infra/network',
        idempotencyKey: key('exp'),
      }),
    );
    expect(after.outcome).toBe('decision_required');
    expect(
      driver.refresh().packets.find((p) => p.id === second)?.authorization,
    ).toBeNull();
  });

  it('cannot create, widen or revoke a grant itself', async () => {
    const api = createIssueApi();
    const cos = await clients(api).cos;
    for (const [name, args] of [
      ['grant_policy', { ...GRANT, confirm: true }],
      ['revoke_policy', { ruleId: 'x', expectedVersion: 1, confirm: true }],
    ] as const) {
      expect(
        (await cos.call(name, { ...args, idempotencyKey: key() })).status,
        name,
      ).toBe(403);
    }
    expect((await cos.ok('read_policy')).rules).toEqual([]);
  });

  it('cannot answer a decision that needs a person, and the person can', async () => {
    const api = createIssueApi();
    const { owner: ownerP, cos: cosP } = clients(api);
    const owner = await ownerP;
    const cos = await cosP;
    const { driver, followUps } = withFollowUps(api, 1);
    const asked = await cos.ok(
      'request_expansion',
      expansionFor(driver.id, followUps[0] as string),
    );
    const id = asked.decision.id as string;
    const listed = await cos.ok('list_decisions', { status: 'open' });
    expect(listed.decisions.map((d: { id: string }) => d.id)).toEqual([id]);

    const refused = await cos.call('answer_decision', {
      decisionId: id,
      version: 1,
      choice: 'approve',
      idempotencyKey: key(),
    });
    expect(refused.isError).toBe(true);
    expect(refused.data.error.code).toMatch(
      /forbidden_actor|delegation_required/,
    );
    expect(
      (await owner.ok('list_decisions', { status: 'open' })).decisions,
    ).toHaveLength(1);

    const answered = await owner.ok('answer_decision', {
      decisionId: id,
      version: 1,
      choice: 'approve',
      idempotencyKey: key(),
    });
    expect(answered.decision.status).toBe('answered');
    expect(
      (await owner.ok('list_decisions', { status: 'open' })).decisions,
    ).toEqual([]);
  });
});

describe('independent review', () => {
  it('is not satisfied by a chief of staff holding a landing grant for everything', async () => {
    const api = createIssueApi();
    const { owner: ownerP, cos: cosP } = clients(api);
    const owner = await ownerP;
    const cos = await cosP;
    const { driver, followUps } = withFollowUps(api, 1);
    await owner.ok('grant_policy', {
      action: '*',
      resource: '*',
      scope: '*',
      maxRisk: 'high',
      grantee: { kind: 'chief_of_staff' },
      idempotencyKey: key(),
      confirm: true,
    });
    const reply = await cos.ok(
      'request_expansion',
      expansionFor(driver.id, followUps[0] as string, {
        action: 'review.independent.approve',
        resource: 'repo:app',
        scope: 'pull:12',
      }),
    );
    expect(reply.outcome).not.toBe('approved');
    expect(reply.tier).toBe(3);
  });
});

describe('proposing a policy change is not granting one', () => {
  it('raises a decision for a person and changes no policy, where grant_policy changes it', async () => {
    const api = createIssueApi();
    const { owner: ownerP, cos: cosP } = clients(api);
    const owner = await ownerP;
    const cos = await cosP;
    const { driver } = withFollowUps(api, 0);
    const before = await cos.ok('read_policy');
    const proposal = {
      missionId: driver.id,
      action: 'deploy.staging',
      resource: 'repo:app',
      scope: 'env:staging',
      maxRisk: 'medium',
      rationale: 'Approved by hand three times this week',
    };
    const proposed = await cos.ok('propose_policy_change', {
      ...proposal,
      idempotencyKey: key(),
    });
    expect(proposed.grants).toBe('nothing');
    expect(proposed.decision).toMatchObject({
      requiredAuthority: 'human',
      status: 'open',
      category: 'novel',
    });
    // The same proposal again is absorbed by the open decision, not duplicated.
    const again = await cos.ok('propose_policy_change', {
      ...proposal,
      idempotencyKey: key(),
    });
    expect(again.created).toBe(false);
    expect(again.decision.id).toBe(proposed.decision.id);

    const after = await cos.ok('read_policy');
    expect(after.policyVersion).toBe(before.policyVersion);
    expect(after.rules).toEqual([]);

    const granted = await owner.ok('grant_policy', {
      action: 'deploy.staging',
      resource: 'repo:app',
      scope: 'env:staging',
      maxRisk: 'medium',
      grantee: { kind: 'chief_of_staff' },
      idempotencyKey: key(),
      confirm: true,
    });
    expect(granted.rule.effect).toBe('allow');
    const final = await cos.ok('read_policy');
    expect(final.policyVersion).toBeGreaterThan(before.policyVersion);
    expect(final.rules).toHaveLength(1);
  });

  it('makes a deny rule unreachable from grant_policy', async () => {
    const api = createIssueApi();
    const owner = await clients(api).owner;
    const granted = await owner.ok('grant_policy', {
      action: 'deploy.staging',
      resource: 'repo:app',
      scope: 'env:staging',
      grantee: { kind: 'chief_of_staff' },
      effect: 'deny',
      idempotencyKey: key(),
      confirm: true,
    });
    expect(granted.rule.effect).toBe('allow');
  });
});
