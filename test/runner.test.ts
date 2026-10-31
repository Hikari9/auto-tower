import { describe, expect, it } from 'vitest';
import { FakeOfficeEngine } from '../src/adapters/office/fake.ts';
import { createApi } from '../src/http/api.ts';
import { MemoryStateStore, RunnerAgent } from '../src/runner/agent.ts';
import { TowerClient } from '../src/runner/client.ts';
import { completion, makeHarness, receipt, registerRunner, simpleMission, type Harness } from './harness.ts';

function agentFor(h: Harness, token: string, name: string, engine = new FakeOfficeEngine(() => ({ steps: 1 })), store = new MemoryStateStore(), extra: Record<string, unknown> = {}) {
  const api = createApi(h.tower);
  const client = new TowerClient({ baseUrl: 'http://tower.test', token, fetch: (u, i) => api(new Request(u, i)) });
  return {
    engine,
    store,
    agent: new RunnerAgent({ client, engine, store, registration: { name, clientVersion: '0.1.0', platform: 'test', engines: ['auto-office'], ...extra } }),
  };
}

describe('runner protocol seam', () => {
  it('dispatches automatically to a newly online runner, end to end over HTTP', async () => {
    const h = await makeHarness();
    const m = await h.tower.missions.create(h.owner, simpleMission());
    expect(m.activity).toBe('waiting_runner');
    const { token } = await h.runnerActor('laptop');
    const { agent } = agentFor(h, token, 'laptop');
    await agent.tick(); // register + claim + start
    expect((await h.tower.repo.mission(h.workspaceId, m.id)).activity).toBe('running');
    await agent.tick(); // running receipt
    await agent.tick(); // completion receipt
    expect((await h.tower.repo.mission(h.workspaceId, m.id)).state).toBe('completed');
    expect(agent.active).toHaveLength(0);
  });

  it('matches capabilities and allowed scopes; ineligible runners leave work waiting', async () => {
    const h = await makeHarness();
    const m = await h.tower.missions.create(h.owner, simpleMission({ packets: [{ title: 'gpu', goal: 'train', scope: { repo: 'acme/app' }, capabilities: ['gpu'] }] }));
    const plain = await registerRunner(h, 'plain');
    expect(await h.tower.runners.claim(plain)).toBeNull();
    const scoped = await registerRunner(h, 'scoped', { capabilities: ['gpu'], allowedScopes: ['repo:other/*'] });
    expect(await h.tower.runners.claim(scoped)).toBeNull();
    const preview = await h.tower.runners.previewDispatch(h.owner, m.id);
    expect(preview.packets[0]!.runners.map((r) => r.reason)).toEqual(['runner lacks capabilities gpu', 'runner is not allowed to work on repo:acme/app#tower/' + m.id]);
    const gpu = await registerRunner(h, 'gpu', { capabilities: ['gpu'] });
    expect(await h.tower.runners.claim(gpu)).not.toBeNull();
  });

  it('never gives two runners the same mutable scope and fences stale receipts', async () => {
    const h = await makeHarness();
    // Two packets that write the same branch: only one may hold it at a time.
    await h.tower.missions.create(
      h.owner,
      simpleMission({
        packets: [
          { title: 'one', goal: 'one', scope: { repo: 'acme/app', branch: 'main-work' } },
          { title: 'two', goal: 'two', scope: { repo: 'acme/app', branch: 'main-work' } },
        ],
      }),
    );
    const r1 = await registerRunner(h, 'one');
    const r2 = await registerRunner(h, 'two');
    const [c1, c2] = await Promise.all([h.tower.runners.claim(r1), h.tower.runners.claim(r2)]);
    expect([c1, c2].filter(Boolean)).toHaveLength(1);
    const c = (c1 ?? c2)!;
    const holder = c1 ? r1 : r2;
    const other = c1 ? r2 : r1;
    // The other runner cannot report on an attempt it does not own.
    await expect(h.tower.runners.report(other, receipt(c.attempt.id, c.attempt.fence, 'progress'))).rejects.toMatchObject({ code: 'forbidden' });
    // A forged older fence is rejected.
    await expect(h.tower.runners.report(holder, receipt(c.attempt.id, c.attempt.fence + 1, 'progress'))).rejects.toMatchObject({ code: 'fenced' });
    await h.tower.runners.report(holder, receipt(c.attempt.id, c.attempt.fence, 'complete', { completion: completion({ integratedVerification: { status: 'not_run', summary: '' } }) }));
    // The scope is released, so the second packet can now be claimed with a higher fence.
    const next = (await h.tower.runners.claim(other))!;
    expect(next.attempt.execScope).toBe(c.attempt.execScope);
    expect(next.attempt.fence).toBe(c.attempt.fence + 1);
  });

  it('treats duplicate receipts as no-ops', async () => {
    const h = await makeHarness();
    await h.tower.missions.create(h.owner, simpleMission());
    const r = await registerRunner(h, 'one');
    const c = (await h.tower.runners.claim(r))!;
    const rc = receipt(c.attempt.id, c.attempt.fence, 'progress', { phase: 'executing' });
    await h.tower.runners.report(r, rc);
    await h.tower.runners.report(r, rc);
    const events = await h.tower.repo.events(h.workspaceId, { streamId: c.attempt.id, afterSeq: 0 });
    expect(events.filter((e) => e.type === 'attempt.progress')).toHaveLength(1);
  });

  it('marks a silent runner lost, keeps the mission waiting, and reconciles the same run when it reconnects', async () => {
    const h = await makeHarness();
    const m = await h.tower.missions.create(h.owner, simpleMission());
    const r = await registerRunner(h, 'sleepy');
    const c = (await h.tower.runners.claim(r))!;
    h.clock.advance(5 * 60_000); // laptop lid closed
    const sweep = await h.tower.scheduler.sweep();
    expect(sweep.leasesExpired).toBe(1);
    expect((await h.tower.repo.packet(h.workspaceId, c.attempt.packetId)).state).toBe('recovering');
    const mission = await h.tower.repo.mission(h.workspaceId, m.id);
    expect(mission.state).toBe('active');
    expect(mission.activity).toBe('waiting_runner');
    // No other runner may take non-portable work.
    const r2 = await registerRunner(h, 'other');
    expect(await h.tower.runners.claim(r2)).toBeNull();
    // Original runner wakes up: same attempt, same fence, continues.
    const hb = await h.tower.runners.heartbeat(r, { attempts: [{ attemptId: c.attempt.id, fence: c.attempt.fence }] });
    expect(hb.directives[0]).toMatchObject({ action: 'continue', reason: expect.stringContaining('recovered') });
    expect((await h.tower.repo.packet(h.workspaceId, c.attempt.packetId)).state).toBe('running');
    await h.tower.runners.report(r, receipt(c.attempt.id, c.attempt.fence, 'complete', { completion: completion() }));
    expect((await h.tower.repo.mission(h.workspaceId, m.id)).state).toBe('completed');
  });

  it('migrates checkpointed work to another runner with a new fence and fences the old one', async () => {
    const h = await makeHarness();
    await h.tower.missions.create(h.owner, simpleMission());
    const r1 = await registerRunner(h, 'first');
    const c = (await h.tower.runners.claim(r1))!;
    await h.tower.runners.report(r1, receipt(c.attempt.id, c.attempt.fence, 'checkpoint', { checkpoint: { portable: true, kind: 'branch', ref: 'tower/x', sha: 'deadbee' } }));
    h.clock.advance(5 * 60_000);
    const r2 = await registerRunner(h, 'second');
    await h.tower.scheduler.sweep();
    expect((await h.tower.repo.packet(h.workspaceId, c.attempt.packetId)).state).toBe('ready');
    const c2 = (await h.tower.runners.claim(r2))!;
    expect(c2.attempt.fence).toBe(c.attempt.fence + 1);
    expect(c2.contract.resumeFrom).toEqual({ kind: 'branch', ref: 'tower/x', sha: 'deadbee' });
    // Old runner returns: told to stop; its receipts are fenced.
    const hb = await h.tower.runners.heartbeat(r1, { attempts: [{ attemptId: c.attempt.id, fence: c.attempt.fence }] });
    expect(hb.directives[0]!.action).toBe('stop');
    await expect(h.tower.runners.report(r1, receipt(c.attempt.id, c.attempt.fence, 'complete', { completion: completion() }))).rejects.toMatchObject({ code: 'fenced' });
    const audit = await h.tower.repo.events(h.workspaceId, { limit: 50 });
    expect(audit.some((e) => e.type === 'receipt.rejected_fenced')).toBe(true);
  });

  it('asks the owner before restarting lost non-portable work, and only that branch waits', async () => {
    const h = await makeHarness({ config: { recoveryMs: 10 * 60_000 } });
    await h.tower.missions.create(h.owner, simpleMission());
    const r1 = await registerRunner(h, 'gone');
    const c = (await h.tower.runners.claim(r1))!;
    h.clock.advance(11 * 60_000);
    await h.tower.scheduler.sweep();
    h.clock.advance(11 * 60_000);
    const s = await h.tower.scheduler.sweep();
    expect(s.recoveryDecisions).toBe(1);
    const d = (await h.tower.decisions.list(h.owner))[0]!;
    expect(d.category).toBe('recovery');
    await h.tower.decisions.answer(h.owner, d.id, { approved: true, alternativeId: 'approve' });
    const r2 = await registerRunner(h, 'new');
    const c2 = (await h.tower.runners.claim(r2))!;
    expect(c2.attempt.packetId).toBe(c.attempt.packetId);
    expect(c2.contract.resumeFrom).toBeNull();
    expect((await h.tower.repo.attempt(h.workspaceId, c.attempt.id)).state).toBe('fenced');
  });

  it('cancels and pauses through heartbeat directives', async () => {
    const h = await makeHarness();
    const m = await h.tower.missions.create(h.owner, simpleMission());
    const r = await registerRunner(h, 'one');
    const c = (await h.tower.runners.claim(r))!;
    await h.tower.missions.pause(h.owner, m.id);
    expect((await h.tower.runners.heartbeat(r, { attempts: [{ attemptId: c.attempt.id, fence: c.attempt.fence }] })).directives[0]!.action).toBe('pause');
    await expect(h.tower.runners.authorizeEffect(r, { attemptId: c.attempt.id, fence: c.attempt.fence, action: 'repo.push', resource: 'repo:acme/app' })).rejects.toMatchObject({ code: 'policy_denied' });
    await h.tower.runners.report(r, receipt(c.attempt.id, c.attempt.fence, 'fail', { failure: { class: 'cancelled', detail: 'paused', retryable: false } }));
    expect((await h.tower.repo.packet(h.workspaceId, c.attempt.packetId)).state).toBe('paused');
    await h.tower.missions.resume(h.owner, m.id);
    const again = (await h.tower.runners.claim(r))!;
    expect(again.attempt.packetId).toBe(c.attempt.packetId);
    await h.tower.runners.packetControl(h.owner, again.attempt.packetId, 'cancel');
    expect((await h.tower.runners.heartbeat(r, { attempts: [{ attemptId: again.attempt.id, fence: again.attempt.fence }] })).directives[0]!.action).toBe('stop');
  });

  it('retries with backoff and classifies failures', async () => {
    const h = await makeHarness();
    await h.tower.missions.create(h.owner, simpleMission());
    const r = await registerRunner(h, 'one');
    const c = (await h.tower.runners.claim(r))!;
    const res = await h.tower.runners.report(r, receipt(c.attempt.id, c.attempt.fence, 'fail', { failure: { class: 'environment', detail: 'disk full', retryable: true } }));
    expect(res).toMatchObject({ failureClass: 'environment', retrying: true });
    expect(await h.tower.runners.claim(r)).toBeNull(); // backoff
    h.clock.advance(31_000);
    const c2 = (await h.tower.runners.claim(r))!;
    await h.tower.runners.report(r, receipt(c2.attempt.id, c2.attempt.fence, 'fail', { failure: { class: 'policy_denial', detail: 'not allowed', retryable: true } }));
    expect((await h.tower.repo.packet(h.workspaceId, c.attempt.packetId)).state).toBe('failed');
  });

  it('quarantines a runner: its attempts are fenced and requeued', async () => {
    const h = await makeHarness();
    await h.tower.missions.create(h.owner, simpleMission());
    const bad = await registerRunner(h, 'bad');
    const c = (await h.tower.runners.claim(bad))!;
    const runnerId = (await h.tower.repo.runnerByPrincipal(bad.principal.id))!.id;
    await h.tower.runners.quarantine(h.owner, runnerId, 'suspicious receipts');
    await expect(h.tower.runners.report(bad, receipt(c.attempt.id, c.attempt.fence, 'progress'))).rejects.toMatchObject({ code: 'fenced' });
    expect(await h.tower.runners.claim(bad)).toBeNull();
    const good = await registerRunner(h, 'good');
    expect((await h.tower.runners.claim(good))!.attempt.fence).toBe(c.attempt.fence + 1);
    await expect(h.tower.runners.quarantine(h.chief, runnerId, 'x')).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('redacts secrets from receipts and evidence', async () => {
    const h = await makeHarness();
    const m = await h.tower.missions.create(h.owner, simpleMission());
    const r = await registerRunner(h, 'one');
    const c = (await h.tower.runners.claim(r))!;
    const leak = 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 and password=hunter22 and sk-ant-api03-abcdefghijklmnopqrstuvwx';
    await h.tower.runners.report(r, receipt(c.attempt.id, c.attempt.fence, 'progress', { message: leak }));
    await h.tower.runners.report(r, receipt(c.attempt.id, c.attempt.fence, 'complete', { completion: completion({ selfVerification: { status: 'pass', summary: leak }, evidence: [{ kind: 'log', summary: leak }] }) }));
    const dump = JSON.stringify(await h.tower.missions.get(h.owner, m.id));
    expect(dump).not.toMatch(/ghp_abc|hunter22|sk-ant-api03/);
    expect(dump).toContain('[REDACTED]');
  });

  it('halts dispatch and guarded effects under emergency halt', async () => {
    const h = await makeHarness();
    await h.tower.missions.create(h.owner, simpleMission());
    const r = await registerRunner(h, 'one');
    await h.tower.admin.setHalt(h.owner, true, 'incident');
    expect(await h.tower.runners.claim(r)).toBeNull();
    await h.tower.admin.setHalt(h.owner, false);
    const c = (await h.tower.runners.claim(r))!;
    await h.tower.admin.setHalt(h.owner, true, 'incident');
    await expect(h.tower.runners.authorizeEffect(r, { attemptId: c.attempt.id, fence: c.attempt.fence, action: 'repo.push', resource: 'repo:acme/app' })).rejects.toMatchObject({ code: 'policy_denied' });
  });

  it('a restarted runner process replays its unacknowledged receipts from durable state', async () => {
    const h = await makeHarness();
    const m = await h.tower.missions.create(h.owner, simpleMission());
    const { token } = await h.runnerActor('laptop');
    const store = new MemoryStateStore();
    const engine = new FakeOfficeEngine(() => ({ steps: 1 }));
    const first = agentFor(h, token, 'laptop', engine, store);
    await first.agent.tick();
    expect(Object.keys(store.state)).toHaveLength(1);
    // Process restarts; the engine still knows its run (e.g. Auto-Office state on disk).
    const second = agentFor(h, token, 'laptop', engine, store);
    await second.agent.tick();
    await second.agent.tick();
    expect((await h.tower.repo.mission(h.workspaceId, m.id)).state).toBe('completed');
  });

  it('two machines share the queue without duplicate writers', async () => {
    const h = await makeHarness();
    const m = await h.tower.missions.create(
      h.owner,
      simpleMission({ packets: [0, 1, 2, 3].map((i) => ({ title: `p${i}`, goal: `g${i}`, scope: { repo: 'acme/app', branch: `b${i}` } })) }),
    );
    const a = agentFor(h, (await h.runnerActor('a')).token, 'a', new FakeOfficeEngine(() => ({ steps: 2 })));
    const b = agentFor(h, (await h.runnerActor('b')).token, 'b', new FakeOfficeEngine(() => ({ steps: 2 })));
    for (let i = 0; i < 12; i++) await Promise.all([a.agent.tick(), b.agent.tick()]);
    const detail = await h.tower.missions.get(h.owner, m.id);
    expect(detail.mission.state).toBe('completed');
    const byRunner = new Set(detail.attempts.map((x) => x.runnerId));
    expect(byRunner.size).toBe(2);
    // Each packet was executed by exactly one successful attempt.
    for (const p of detail.packets) expect(detail.attempts.filter((x) => x.packetId === p.id && x.state === 'succeeded')).toHaveLength(1);
  });

  it('lands only after Tower authorizes the landing with independent review', async () => {
    const h = await makeHarness();
    const m = await h.tower.missions.create(h.owner, simpleMission({ authority: { actions: ['repo.push', 'merge'], resources: ['repo:acme/app'] } }));
    const { token } = await h.runnerActor('laptop');
    const { agent } = agentFor(h, token, 'laptop', new FakeOfficeEngine(() => ({ steps: 1, landAction: 'merge' })));
    for (let i = 0; i < 4; i++) await agent.tick();
    const detail = await h.tower.missions.get(h.owner, m.id);
    expect(detail.mission.state).toBe('completed');
    expect(detail.events.some((e) => e.type === 'effect.authorized')).toBe(true);
    expect((detail.packets[0]!.result as { landing: { status: string } }).landing.status).toBe('landed');
  });
});
