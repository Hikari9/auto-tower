import { describe, expect, it } from 'vitest';
import { completion, makeHarness, receipt, registerRunner, simpleMission } from './harness.ts';

describe('mission API and state', () => {
  it('creates a durable mission that waits for a runner instead of claiming work runs', async () => {
    const h = await makeHarness();
    const m = await h.tower.missions.create(h.owner, simpleMission());
    expect(m.state).toBe('active');
    expect(m.activity).toBe('waiting_runner');
    expect(m.blockers.some((b) => b.kind === 'runner')).toBe(true);
    const detail = await h.tower.missions.get(h.chief, m.id);
    expect(detail.packets[0]!.state).toBe('ready');
    expect(detail.events.map((e) => e.type)).toEqual(expect.arrayContaining(['mission.created', 'packet.created', 'mission.started', 'packet.ready']));
  });

  it('runs a single-packet low-risk mission to verified completion', async () => {
    const h = await makeHarness();
    const m = await h.tower.missions.create(h.owner, simpleMission());
    const runner = await registerRunner(h, 'laptop');
    const claim = (await h.tower.runners.claim(runner))!;
    expect(claim.contract.contract).toBe('tower.dispatch/v1');
    expect(claim.contract.evidenceProfile.integratedVerification).toBe(true);
    await h.tower.runners.report(runner, receipt(claim.attempt.id, claim.attempt.fence, 'progress', { phase: 'executing' }));
    expect((await h.tower.repo.mission(h.workspaceId, m.id)).activity).toBe('running');
    await h.tower.runners.report(runner, receipt(claim.attempt.id, claim.attempt.fence, 'complete', { completion: completion() }));
    const done = await h.tower.repo.mission(h.workspaceId, m.id);
    expect(done.state).toBe('completed');
    expect(done.verification?.verdict).toBe('pass');
  });

  it('rejects invalid transitions and stale versions', async () => {
    const h = await makeHarness();
    const m = await h.tower.missions.create(h.owner, simpleMission({ start: false }));
    await expect(h.tower.missions.verify(h.owner, m.id, { verdict: 'pass' })).rejects.toMatchObject({ code: 'invalid_transition' });
    await h.tower.missions.update(h.owner, m.id, m.version, { title: 'Renamed' });
    await expect(h.tower.missions.update(h.owner, m.id, m.version, { title: 'Stale' })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('serializes concurrent writers with the event-stream version guard', async () => {
    const h = await makeHarness();
    const m = await h.tower.missions.create(h.owner, simpleMission({ start: false }));
    const tx1 = h.tower.uow(h.owner);
    const tx2 = h.tower.uow(h.chief);
    tx1.event({ stream: 'mission', id: m.id, expected: m.version, type: 'test.a' });
    tx2.event({ stream: 'mission', id: m.id, expected: m.version, type: 'test.b' });
    await tx1.commit(h.db);
    await expect(tx2.commit(h.db)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('makes duplicate creates idempotent and rejects a reused key with a different body', async () => {
    const h = await makeHarness();
    const a = await h.tower.missions.create(h.owner, simpleMission(), 'key-1');
    const b = await h.tower.missions.create(h.owner, simpleMission(), 'key-1');
    expect(b.id).toBe(a.id);
    expect((await h.tower.missions.list(h.owner)).length).toBe(1);
    await expect(h.tower.missions.create(h.owner, simpleMission({ title: 'other' }), 'key-1')).rejects.toMatchObject({ code: 'idempotency_mismatch' });
  });

  it('gates packets on dependencies and adds an integration packet for multi-part work', async () => {
    const h = await makeHarness();
    const m = await h.tower.missions.create(
      h.owner,
      simpleMission({
        packets: [
          { title: 'API', goal: 'Build API', scope: { repo: 'acme/app', branch: 'api' } },
          { title: 'UI', goal: 'Build UI', scope: { repo: 'acme/app', branch: 'ui' }, dependsOnIndex: [0] },
        ],
      }),
    );
    let detail = await h.tower.missions.get(h.owner, m.id);
    expect(detail.packets.map((p) => p.state)).toEqual(['ready', 'pending']);
    const runner = await registerRunner(h, 'laptop');
    const c1 = (await h.tower.runners.claim(runner))!;
    expect(c1.contract.packet.title).toBe('API');
    expect(await h.tower.runners.claim(runner)).toBeNull(); // concurrency 1
    await h.tower.runners.report(runner, receipt(c1.attempt.id, c1.attempt.fence, 'complete', { completion: completion({ integratedVerification: { status: 'not_run', summary: '' } }) }));
    detail = await h.tower.missions.get(h.owner, m.id);
    expect(detail.packets.map((p) => p.state)).toEqual(['done', 'ready']);
    const c2 = (await h.tower.runners.claim(runner))!;
    await h.tower.runners.report(runner, receipt(c2.attempt.id, c2.attempt.fence, 'complete', { completion: completion({ integratedVerification: { status: 'not_run', summary: '' } }) }));
    detail = await h.tower.missions.get(h.owner, m.id);
    // Partial child completion does not complete the mission: Tower adds an integration packet.
    expect(detail.mission.state).toBe('active');
    const integ = detail.packets.find((p) => p.kind === 'integration')!;
    expect(integ.state).toBe('ready');
    const c3 = (await h.tower.runners.claim(runner))!;
    expect(c3.contract.packet.kind).toBe('integration');
    expect(c3.contract.evidenceProfile.integratedVerification).toBe(true);
    await h.tower.runners.report(runner, receipt(c3.attempt.id, c3.attempt.fence, 'complete', { completion: completion() }));
    expect((await h.tower.repo.mission(h.workspaceId, m.id)).state).toBe('completed');
  });

  it('requires explicit verification for high-risk missions even when every gate is green', async () => {
    const h = await makeHarness();
    const m = await h.tower.missions.create(h.owner, simpleMission({ risk: 'high' }));
    const runner = await registerRunner(h, 'laptop');
    const c = (await h.tower.runners.claim(runner))!;
    await h.tower.runners.report(runner, receipt(c.attempt.id, c.attempt.fence, 'complete', { completion: completion() }));
    let cur = await h.tower.repo.mission(h.workspaceId, m.id);
    expect(cur.state).toBe('verifying');
    // A single high-risk packet still needs an independently reviewed integration result.
    await expect(h.tower.missions.verify(h.owner, m.id, { verdict: 'pass' })).rejects.toMatchObject({ code: 'invalid' });
    // The chief cannot verify without a delegated mission.verify rule.
    await expect(h.tower.missions.verify(h.chief, m.id, { verdict: 'fail' })).rejects.toMatchObject({ code: 'policy_denied' });
    await h.tower.missions.addPacket(h.owner, m.id, { title: 'Integration', goal: 'Verify all', kind: 'integration', scope: { repo: 'acme/app' } });
    const c2 = (await h.tower.runners.claim(runner))!;
    await h.tower.runners.report(runner, receipt(c2.attempt.id, c2.attempt.fence, 'complete', { completion: completion() }));
    cur = await h.tower.repo.mission(h.workspaceId, m.id);
    expect(cur.state).toBe('verifying');
    await h.tower.missions.verify(h.owner, m.id, { verdict: 'pass', note: 'checked prod plan' });
    expect((await h.tower.repo.mission(h.workspaceId, m.id)).state).toBe('completed');
  });

  it('completes a parent only after its children complete and the integrated result is verified', async () => {
    const h = await makeHarness();
    const parent = await h.tower.missions.create(h.owner, { title: 'Launch', intent: 'launch', outcome: 'launched', risk: 'low', start: true });
    const c1 = await h.tower.missions.create(h.owner, simpleMission({ parentId: parent.id, title: 'Child 1' }));
    await h.tower.missions.create(h.owner, simpleMission({ parentId: parent.id, title: 'Child 2', packets: [{ title: 'b', goal: 'b', scope: { repo: 'acme/app', branch: 'b' } }] }));
    const runner = await registerRunner(h, 'laptop', { maxConcurrency: 2 });
    for (let i = 0; i < 2; i++) {
      const c = (await h.tower.runners.claim(runner))!;
      await h.tower.runners.report(runner, receipt(c.attempt.id, c.attempt.fence, 'complete', { completion: completion() }));
    }
    expect((await h.tower.repo.mission(h.workspaceId, c1.id)).state).toBe('completed');
    const p = await h.tower.missions.get(h.owner, parent.id);
    expect(p.mission.state).toBe('active');
    expect(p.packets[0]!.kind).toBe('integration');
    const c = (await h.tower.runners.claim(runner))!;
    await h.tower.runners.report(runner, receipt(c.attempt.id, c.attempt.fence, 'complete', { completion: completion() }));
    expect((await h.tower.repo.mission(h.workspaceId, parent.id)).state).toBe('completed');
  });

  it('cancelling a mission withdraws its decisions and cancels running work', async () => {
    const h = await makeHarness();
    const m = await h.tower.missions.create(h.owner, simpleMission());
    const runner = await registerRunner(h, 'laptop');
    const c = (await h.tower.runners.claim(runner))!;
    await h.tower.missions.cancel(h.owner, m.id, 'changed plans');
    const hb = await h.tower.runners.heartbeat(runner, { attempts: [{ attemptId: c.attempt.id, fence: c.attempt.fence }] });
    expect(hb.directives[0]!.action).toBe('stop');
    await expect(h.tower.runners.report(runner, receipt(c.attempt.id, c.attempt.fence, 'complete', { completion: completion() }))).rejects.toMatchObject({ code: 'fenced' });
  });

  it('replays the audit trail for a mission in order', async () => {
    const h = await makeHarness();
    const m = await h.tower.missions.create(h.owner, simpleMission());
    await h.tower.missions.pause(h.owner, m.id, 'wait');
    await h.tower.missions.resume(h.owner, m.id);
    const events = (await h.tower.repo.events(h.workspaceId, { missionId: m.id, afterSeq: 0 })).filter((e) => e.streamType === 'mission');
    expect(events.map((e) => e.streamVersion)).toEqual(events.map((_, i) => i + 1));
    expect(events.map((e) => e.type)).toEqual(['mission.created', 'mission.started', 'mission.paused', 'mission.resumed']);
    expect(events.every((e) => e.correlationId && e.actorId)).toBe(true);
  });
});
