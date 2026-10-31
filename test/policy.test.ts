import { describe, expect, it } from 'vitest';
import { evaluatePolicy } from '../src/domain/policy.ts';
import { completion, makeHarness, receipt, registerRunner, simpleMission } from './harness.ts';

async function runningAttempt(h: Awaited<ReturnType<typeof makeHarness>>, over: Record<string, unknown> = {}) {
  const m = await h.tower.missions.create(h.owner, simpleMission(over));
  const runner = await registerRunner(h, `r-${Math.random().toString(36).slice(2, 7)}`);
  const c = (await h.tower.runners.claim(runner))!;
  return { m, runner, c };
}

describe('policy and decision seam', () => {
  it('lets in-scope follow-up work proceed without asking anyone', async () => {
    const h = await makeHarness();
    const { m, runner, c } = await runningAttempt(h);
    const p = await h.tower.runners.createFollowup(runner, { attemptId: c.attempt.id, fence: c.attempt.fence, title: 'Fix lint', goal: 'Fix lint found during work', scope: { repo: 'acme/app', branch: 'lint' } });
    expect(p.origin).toBe('followup');
    expect(p.state).toBe('pending');
    expect((await h.tower.repo.packet(h.workspaceId, p.id)).state).toBe('ready');
    expect(await h.tower.decisions.list(h.owner)).toHaveLength(0);
    // Out-of-envelope follow-ups are refused and must go through an expansion.
    await expect(
      h.tower.runners.createFollowup(runner, { attemptId: c.attempt.id, fence: c.attempt.fence, title: 'x', goal: 'x', scope: { repo: 'acme/other' } }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    expect((await h.tower.repo.mission(h.workspaceId, m.id)).state).toBe('active');
  });

  it('routes an uncovered expansion to the human inbox and holds only that branch', async () => {
    const h = await makeHarness();
    const { m, runner, c } = await runningAttempt(h);
    const other = await h.tower.missions.create(h.owner, simpleMission({ title: 'Other', packets: [{ title: 'o', goal: 'o', scope: { repo: 'acme/app', branch: 'other' } }] }));
    const res = await h.tower.runners.requestExpansion(runner, {
      attemptId: c.attempt.id,
      fence: c.attempt.fence,
      action: 'repo.push',
      resource: 'repo:acme/infra',
      reason: 'Needs a config change in infra',
    });
    expect(res).toMatchObject({ status: 'pending', audience: 'human' });
    expect((await h.tower.repo.packet(h.workspaceId, c.attempt.packetId)).state).toBe('held');
    expect((await h.tower.repo.mission(h.workspaceId, m.id)).activity).toBe('waiting_decision');
    // Unrelated work is still claimable.
    const runner2 = await registerRunner(h, 'second');
    const c2 = (await h.tower.runners.claim(runner2))!;
    expect(c2.attempt.missionId).toBe(other.id);
    // Heartbeat tells the holding runner to wait, without fencing it.
    expect((await h.tower.runners.heartbeat(runner, { attempts: [{ attemptId: c.attempt.id, fence: c.attempt.fence }] })).directives[0]!.action).toBe('hold');

    const d = (await h.tower.decisions.list(h.owner, { status: 'open' }))[0]!;
    await expect(h.tower.decisions.answer(h.chief, d.id, { approved: true })).rejects.toMatchObject({ code: 'forbidden' });
    await h.tower.decisions.answer(h.owner, d.id, { approved: true, note: 'ok this once' });
    expect((await h.tower.repo.packet(h.workspaceId, c.attempt.packetId)).state).toBe('running');
    expect((await h.tower.repo.mission(h.workspaceId, m.id)).authority.resources).toContain('repo:acme/infra');
    // One-off approval does not create a rule.
    expect((await h.tower.policy.list(h.owner)).rules).toHaveLength(0);
  });

  it('lets the chief approve only under a current delegated rule, and revocation applies to the next decision', async () => {
    const h = await makeHarness();
    const rule = await h.tower.policy.grant(h.owner, { action: 'deploy.preview', resource: 'env:preview/*', grantee: 'chief', conditions: { maxRisk: 'medium' } });
    const { runner, c } = await runningAttempt(h);
    const r1 = await h.tower.runners.requestExpansion(runner, { attemptId: c.attempt.id, fence: c.attempt.fence, action: 'deploy.preview', resource: 'env:preview/app', reason: 'preview deploy', risk: 'low' });
    expect(r1).toMatchObject({ status: 'pending', audience: 'chief' });
    const d = await h.tower.decisions.answer(h.chief, r1.decisionId!, { approved: true });
    expect(d.ruleRef).toEqual({ ruleId: rule.id, policyVersion: 1 });
    expect(d.answeredBy).toBe(h.chief.principal.id);

    await h.tower.policy.revoke(h.owner, rule.id, 'no more');
    const r2 = await h.tower.runners.requestExpansion(runner, { attemptId: c.attempt.id, fence: c.attempt.fence, action: 'deploy.preview', resource: 'env:preview/other', reason: 'second', risk: 'low' });
    expect(r2).toMatchObject({ status: 'pending', audience: 'human' });
    await expect(h.tower.decisions.answer(h.chief, r2.decisionId!, { approved: true })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('escalates a chief approval that its grant does not cover (risk above the ceiling)', async () => {
    const h = await makeHarness();
    await h.tower.policy.grant(h.owner, { action: 'deploy.preview', resource: '*', grantee: 'chief', conditions: { maxRisk: 'low' } });
    const { runner, c } = await runningAttempt(h);
    const r = await h.tower.runners.requestExpansion(runner, { attemptId: c.attempt.id, fence: c.attempt.fence, action: 'deploy.preview', resource: 'env:preview/a', reason: 'x', risk: 'low' });
    // Rule changes between raise and answer: the answer is evaluated at the point of approval.
    const rules = (await h.tower.policy.list(h.owner)).rules;
    await h.tower.policy.amend(h.owner, rules[0]!.id, { conditions: { maxRisk: 'low', missionIds: ['msn_other'] } });
    await expect(h.tower.decisions.answer(h.chief, r.decisionId!, { approved: true })).rejects.toMatchObject({ code: 'policy_denied' });
    const d = await h.tower.decisions.get(h.owner, r.decisionId!);
    expect(d.audience).toBe('human');
    expect(d.status).toBe('open');
  });

  it('blocks a guarded effect immediately after revocation, and keeps the history auditable', async () => {
    const h = await makeHarness();
    const rule = await h.tower.policy.grant(h.owner, { action: 'deploy.preview', resource: 'env:preview/*', grantee: 'runner' });
    const { runner, c } = await runningAttempt(h);
    const ok = await h.tower.runners.authorizeEffect(runner, { attemptId: c.attempt.id, fence: c.attempt.fence, action: 'deploy.preview', resource: 'env:preview/app' });
    expect(ok).toMatchObject({ allowed: true, basis: 'rule', ruleId: rule.id, policyVersion: 1 });
    await h.tower.policy.revoke(h.owner, rule.id);
    await expect(h.tower.runners.authorizeEffect(runner, { attemptId: c.attempt.id, fence: c.attempt.fence, action: 'deploy.preview', resource: 'env:preview/app' })).rejects.toMatchObject({
      code: 'policy_denied',
    });
    const events = await h.tower.repo.events(h.workspaceId, { streamId: c.attempt.id, afterSeq: 0 });
    const effects = events.filter((e) => e.type.startsWith('effect.'));
    expect(effects.map((e) => [e.type, e.policy?.policyVersion])).toEqual([
      ['effect.authorized', 1],
      ['effect.denied', 2],
    ]);
    expect((await h.tower.repo.rule(h.workspaceId, rule.id)).uses).toBe(1);
  });

  it('enforces explicit deny over the mission envelope, and default-denies sensitive actions', async () => {
    const h = await makeHarness();
    const { runner, c } = await runningAttempt(h, { authority: { actions: ['repo.push', 'deploy.prod'], resources: ['repo:acme/app', 'env:prod'] } });
    // The owner put deploy.prod in the envelope explicitly, so it is allowed...
    await expect(h.tower.runners.authorizeEffect(runner, { attemptId: c.attempt.id, fence: c.attempt.fence, action: 'deploy.prod', resource: 'env:prod' })).resolves.toMatchObject({ allowed: true });
    // ...until an explicit deny rule, which always wins.
    await h.tower.policy.grant(h.owner, { effect: 'deny', action: 'deploy.prod', resource: '*', grantee: 'any' });
    await expect(h.tower.runners.authorizeEffect(runner, { attemptId: c.attempt.id, fence: c.attempt.fence, action: 'deploy.prod', resource: 'env:prod' })).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(h.tower.runners.authorizeEffect(runner, { attemptId: c.attempt.id, fence: c.attempt.fence, action: 'spend.usd', resource: 'vendor:x' })).rejects.toMatchObject({ code: 'policy_denied' });
    // A chief cannot create a mission envelope with sensitive actions.
    await expect(h.tower.missions.create(h.chief, simpleMission({ start: false, authority: { actions: ['deploy.prod'], resources: ['env:prod'] } }))).rejects.toMatchObject({ code: 'policy_denied' });
  });

  it('expires grants and enforces maxUses', () => {
    const base = { workspaceId: 'w', status: 'active' as const, uses: 0, supersedes: null, source: 'explicit' as const, createdBy: 'u', createdAt: '', createdPolicyVersion: 1, revokedBy: null, revokedAt: null, note: '', version: 1 };
    const rules = [
      { ...base, id: 'r1', effect: 'allow' as const, action: 'a', resource: '*', grantee: 'runner' as const, conditions: {}, expiresAt: '2026-01-01T00:00:00Z' },
      { ...base, id: 'r2', effect: 'allow' as const, action: 'b', resource: '*', grantee: 'runner' as const, conditions: { maxUses: 1 }, expiresAt: null, uses: 1 },
    ];
    const ctx = { rules, policyVersion: 3, now: '2026-11-01T00:00:00Z', halted: false };
    expect(evaluatePolicy({ grantee: 'runner', action: 'a', resource: 'x', risk: 'low' }, ctx).allowed).toBe(false);
    expect(evaluatePolicy({ grantee: 'runner', action: 'b', resource: 'x', risk: 'low' }, ctx).allowed).toBe(false);
    expect(evaluatePolicy({ grantee: 'runner', action: 'b', resource: 'x', risk: 'low' }, { ...ctx, halted: true }).basis).toBe('halted');
  });

  it('proposes a standing rule after repeated approvals but grants nothing until accepted', async () => {
    const h = await makeHarness();
    // Each approval extends only its own mission's envelope, so use a fresh mission each time.
    const ask = async (i: number) => {
      const { runner, c } = await runningAttempt(h, { title: `m${i}`, packets: [{ title: 'p', goal: 'p', scope: { repo: 'acme/app', branch: `b${i}` } }] });
      return h.tower.runners.requestExpansion(runner, { attemptId: c.attempt.id, fence: c.attempt.fence, action: 'deploy.preview', resource: 'env:preview/app', reason: `deploy ${i}`, risk: 'low' });
    };
    for (let i = 0; i < 3; i++) {
      const r = await ask(i);
      await h.tower.decisions.answer(h.owner, r.decisionId!, { approved: true });
    }
    let policy = await h.tower.policy.list(h.owner);
    expect(policy.rules).toHaveLength(0);
    expect(policy.preferences.find((p) => p.key.startsWith('approval:'))?.observedCount).toBe(3);
    const prop = policy.proposals.find((p) => p.status === 'pending')!;
    expect(prop.proposed).toMatchObject({ action: 'deploy.preview', resource: 'env:preview/app' });
    // The 4th similar request still goes to the human: observations never authorize.
    const r4 = await ask(4);
    expect(r4).toMatchObject({ audience: 'human' });
    // Narrowing cannot widen.
    await expect(h.tower.policy.acceptProposal(h.owner, prop.id, { resource: '*' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(h.tower.policy.acceptProposal(h.chief, prop.id)).rejects.toMatchObject({ code: 'forbidden' });
    const rule = await h.tower.policy.acceptProposal(h.owner, prop.id, { conditions: { maxUses: 10 } });
    expect(rule).toMatchObject({ source: 'proposal', grantee: 'chief', conditions: { maxRisk: 'low', maxUses: 10 } });
    policy = await h.tower.policy.list(h.owner);
    expect(policy.proposals.find((p) => p.id === prop.id)!.status).toBe('accepted');
  });

  it('dedupes decisions shared by several branches and resumes only those branches', async () => {
    const h = await makeHarness();
    const m = await h.tower.missions.create(
      h.owner,
      simpleMission({
        packets: [
          { title: 'a', goal: 'a', scope: { repo: 'acme/app', branch: 'a' } },
          { title: 'b', goal: 'b', scope: { repo: 'acme/app', branch: 'b' } },
          { title: 'c', goal: 'c', scope: { repo: 'acme/app', branch: 'c' } },
        ],
      }),
    );
    const runner = await registerRunner(h, 'big', { maxConcurrency: 3 });
    const claims = [(await h.tower.runners.claim(runner))!, (await h.tower.runners.claim(runner))!, (await h.tower.runners.claim(runner))!];
    const ask = (i: number) =>
      h.tower.runners.requestExpansion(runner, { attemptId: claims[i]!.attempt.id, fence: claims[i]!.attempt.fence, action: 'pkg.add', resource: 'npm:left-pad', reason: 'need dep' });
    const r0 = await ask(0);
    const r1 = await ask(1);
    expect(r1.decisionId).toBe(r0.decisionId);
    const d = await h.tower.decisions.get(h.owner, r0.decisionId!);
    expect(d.linkedPackets.sort()).toEqual([claims[0]!.attempt.packetId, claims[1]!.attempt.packetId].sort());
    await h.tower.decisions.answer(h.owner, d.id, { approved: false, note: 'no new deps' });
    const states = (await h.tower.missions.get(h.owner, m.id)).packets.map((p) => p.state);
    expect(states).toEqual(['running', 'running', 'leased']);
    // A second, out-of-order answer to the same decision is rejected.
    await expect(h.tower.decisions.answer(h.owner, d.id, { approved: true })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('never lets a producer or a chief grant satisfy required independent review', async () => {
    const h = await makeHarness();
    await h.tower.policy.grant(h.owner, { action: 'merge', resource: 'repo:acme/app', grantee: 'runner' });
    const { runner, c } = await runningAttempt(h, { risk: 'high' });
    const base = { attemptId: c.attempt.id, fence: c.attempt.fence, action: 'merge', resource: 'repo:acme/app', producerSessionId: 'prod-1' };
    await expect(h.tower.runners.authorizeEffect(runner, base)).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(
      h.tower.runners.authorizeEffect(runner, { ...base, review: { status: 'approved', reviewer: { id: 'me', sessionId: 'prod-1', kind: 'agent' }, independence: 'independent' } }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(
      h.tower.runners.authorizeEffect(runner, { ...base, review: { status: 'approved', reviewer: { id: 'rico', sessionId: 'cos-1', kind: 'chief' }, independence: 'independent' } }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(
      h.tower.runners.authorizeEffect(runner, { ...base, review: { status: 'approved', reviewer: { id: 'rev', sessionId: 'rev-1', kind: 'agent' }, independence: 'independent' } }),
    ).resolves.toMatchObject({ allowed: true });
    // Completion gate: a self-approved receipt does not complete a high-risk packet.
    await h.tower.runners.report(
      runner,
      receipt(c.attempt.id, c.attempt.fence, 'complete', { completion: completion({ independentReview: { status: 'approved', reviewer: { id: 'p', sessionId: 'producer-session', kind: 'agent' }, independence: 'independent', summary: '' } }) }),
    );
    const p = await h.tower.repo.packet(h.workspaceId, c.attempt.packetId);
    expect(p.state).toBe('ready');
    expect(p.gate?.reasons).toContain('the producing session cannot approve its own work');
  });
});
