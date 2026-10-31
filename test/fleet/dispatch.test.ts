import { describe, expect, it } from 'vitest';
import { auditKinds, createFleetHarness } from './helpers.js';

describe('the broker', () => {
  it('leaves authorized work waiting-runner while no runner exists', async () => {
    const h = createFleetHarness();
    const { id, packetIds } = h.mission([{}]);
    h.tick();
    h.tick();
    const state = h.getMission(id);
    expect(state.state).toBe('waiting-runner');
    expect(state.packets.find((p) => p.id === packetIds[0])?.status).toBe(
      'ready',
    );
    expect(state.attempts).toHaveLength(0);
  });

  it('dispatches on the next poll with no human action, and the runner gets the work', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    const { id, packetIds } = h.mission([
      { title: 'ship it', instructions: 'ship it now', scope: ['repo:app'] },
    ]);
    // Nobody ticked. The poll itself schedules.
    expect(h.getMission(id).state).toBe('ready');

    const res = await runner.claim();
    expect(res.status).toBe(200);
    expect(res.body.assignments).toHaveLength(1);
    const [assignment] = res.body.assignments;
    expect(assignment).toMatchObject({
      missionId: id,
      packetId: packetIds[0],
      scopeKey: 'repo:app#worktree:default',
      fence: 1,
      packet: { title: 'ship it', instructions: 'ship it now' },
      resume: null,
    });
    const state = h.getMission(id);
    expect(state.state).toBe('running');
    expect(state.attempts[0]).toMatchObject({
      runnerId: runner.id,
      status: 'running',
    });
    // A second poll hands out nothing twice.
    expect((await runner.claim()).body.assignments).toHaveLength(0);
  });

  it('requires the declared capability, and re-evaluates when it changes', async () => {
    const h = createFleetHarness();
    const runner = await h.runner({ capabilities: [] });
    const { id } = h.mission([{ scope: ['cap:docker', 'repo:app'] }]);

    expect((await runner.claim()).body.assignments).toHaveLength(0);
    expect(h.getMission(id).attempts).toHaveLength(0);

    // Declaring the capability on the next poll is enough: nothing else to refresh.
    const res = await runner.claim({ capabilities: ['docker'] });
    expect(res.body.assignments).toHaveLength(1);
    expect(auditKinds(h)).toContain('runner.capabilities_changed');
  });

  it('withdraws an offer when the capability goes away, and offers it again when it returns', async () => {
    const h = createFleetHarness();
    const runner = await h.runner({
      capabilities: ['docker'],
      maxConcurrent: 2,
    });
    await runner.claim();
    // Dispatched while the runner was capable, but not collected yet.
    const second = h.mission([{ scope: ['cap:docker', 'repo:two'] }]);
    h.tick();
    expect(h.getMission(second.id).attempts).toHaveLength(1);
    expect(h.getMission(second.id).attempts[0]?.status).toBe('leased');

    const dropped = await runner.claim({ capabilities: [] });
    expect(dropped.body.assignments).toHaveLength(0);
    expect(dropped.body.withheld).toEqual([
      {
        attemptId: h.getMission(second.id).attempts[0]?.id,
        reason: 'missing capability docker',
      },
    ]);
    expect(h.getMission(second.id).attempts[0]?.status).toBe('leased');

    const back = await runner.claim({ capabilities: ['docker'] });
    expect(back.body.assignments).toHaveLength(1);
  });

  it('keeps work inside the scopes the human allowed', async () => {
    const h = createFleetHarness();
    const runner = await h.runner({ allowedScopes: ['repo:app'] });
    const { id } = h.mission([{ scope: ['repo:secrets'] }]);
    expect((await runner.claim()).body.assignments).toHaveLength(0);
    expect(h.getMission(id).attempts).toHaveLength(0);
    expect(h.getMission(id).state).toBe('waiting-runner');
  });

  it('allows a scope by prefix', async () => {
    const h = createFleetHarness();
    const runner = await h.runner({ allowedScopes: ['repo:*'] });
    h.mission([{ scope: ['repo:anything'] }]);
    expect((await runner.claim()).body.assignments).toHaveLength(1);
  });

  it('spreads work by load and never passes max concurrency', async () => {
    const h = createFleetHarness();
    const a = await h.runner({ name: 'a', maxConcurrent: 1 });
    const b = await h.runner({ name: 'b', maxConcurrent: 1 });
    await a.claim();
    await b.claim();
    h.mission([
      { scope: ['repo:one'] },
      { scope: ['repo:two'] },
      { scope: ['repo:three'] },
    ]);

    const first = await a.claim();
    const second = await b.claim();
    expect(first.body.assignments).toHaveLength(1);
    expect(second.body.assignments).toHaveLength(1);
    // The third waits: both runners are full.
    expect((await a.claim()).body.assignments).toHaveLength(0);
    expect((await b.claim()).body.assignments).toHaveLength(0);
    const waiting = h
      .getMission(first.body.assignments[0].missionId)
      .packets.filter((p) => p.status === 'ready');
    expect(waiting).toHaveLength(1);
  });

  it('prefers the runner that last held the scope', async () => {
    const h = createFleetHarness();
    const a = await h.runner({ name: 'a', maxConcurrent: 2 });
    const b = await h.runner({ name: 'b', maxConcurrent: 2 });
    await a.claim();
    await b.claim();
    h.mission([{ scope: ['repo:app'] }]);
    // Make b the lighter runner so only affinity can favour a.
    const got = [await a.claim(), await b.claim()].flatMap(
      (r) => r.body.assignments,
    );
    expect(got).toHaveLength(1);
    const holder = h.db.get<{ runner_id: string }>(
      'SELECT runner_id FROM runner_leases',
    )?.runner_id;
    const winner = holder === a.id ? a : b;
    const other = winner === a ? b : a;
    const leaseId = got[0].leaseId;
    await winner.receipt(leaseId, {
      receiptId: 'r1',
      fence: got[0].fence,
      outcome: 'succeeded',
    });

    h.mission([{ scope: ['repo:app'] }]);
    // The other runner polls first and is the lighter one, yet affinity sends the work to the winner.
    expect((await other.claim()).body.assignments).toHaveLength(0);
    expect((await winner.claim()).body.assignments).toHaveLength(1);
  });

  it('does not offer work to a runner that has not been heard from', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    await runner.claim();
    h.clock.advance(h.config.livenessWindowMs + 1_000);
    const { id } = h.mission([{}]);
    h.tick();
    expect(h.getMission(id).attempts).toHaveLength(0);
    expect((await runner.claim()).body.assignments).toHaveLength(1);
  });

  it('re-evaluates quota: a lowered maxConcurrent stops new claims', async () => {
    const h = createFleetHarness();
    const runner = await h.runner({ maxConcurrent: 2 });
    await runner.claim();
    h.mission([{ scope: ['repo:one'] }]);
    h.tick();
    const attempt = h.db.get<{ id: string }>(
      'SELECT id FROM execution_attempts',
    )?.id;
    expect(attempt).toBeDefined();

    const patched = await h.call(
      h.owner.token,
      'PATCH',
      `/runners/${runner.id}`,
      { maxConcurrent: 0 },
    );
    expect(patched.status).toBe(200);
    const res = await runner.claim();
    expect(res.body.assignments).toHaveLength(0);
    expect(res.body.withheld[0].reason).toBe('runner is at capacity');

    await h.call(h.owner.token, 'PATCH', `/runners/${runner.id}`, {
      maxConcurrent: 1,
    });
    expect((await runner.claim()).body.assignments).toHaveLength(1);
  });

  it('re-evaluates allowed scopes when a human narrows them', async () => {
    const h = createFleetHarness();
    const runner = await h.runner({ allowedScopes: ['repo:*'] });
    await runner.claim();
    h.mission([{ scope: ['repo:app'] }]);
    h.tick();
    await h.call(h.owner.token, 'PATCH', `/runners/${runner.id}`, {
      allowedScopes: ['repo:other'],
    });
    const res = await runner.claim();
    expect(res.body.assignments).toHaveLength(0);
    expect(res.body.withheld[0].reason).toBe('scope repo:app is not allowed');
  });
});

describe('pause and quarantine', () => {
  it('gives a paused runner no new work and tells it to pause', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    h.mission([{ scope: ['repo:one'] }]);
    const first = await runner.claim();
    expect(first.body.assignments).toHaveLength(1);

    await h.call(h.owner.token, 'PATCH', `/runners/${runner.id}`, {
      paused: true,
    });
    h.mission([{ scope: ['repo:two'] }]);
    const res = await runner.claim({
      active: [evidenceOf(first.body.assignments[0])],
    });
    expect(res.body.assignments).toHaveLength(0);
    expect(res.body.leases[0].directives).toEqual({
      cancel: false,
      pause: true,
    });

    await h.call(h.owner.token, 'PATCH', `/runners/${runner.id}`, {
      paused: false,
    });
    expect((await runner.claim()).body.assignments).toHaveLength(1);
  });

  it('refuses a quarantined runner every claim and sends it no work', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    await runner.claim();
    const out = await h.call(
      h.owner.token,
      'POST',
      `/runners/${runner.id}/quarantine`,
      { reason: 'odd behaviour' },
    );
    expect(out.status).toBe(200);
    expect(out.body.runner.status).toBe('quarantined');

    const { id } = h.mission([{}]);
    const res = await runner.claim();
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('runner_quarantined');
    expect((await runner.heartbeat()).status).toBe(403);
    h.tick();
    expect(h.getMission(id).attempts).toHaveLength(0);

    await h.call(h.owner.token, 'POST', `/runners/${runner.id}/unquarantine`);
    expect((await runner.claim()).body.assignments).toHaveLength(1);
  });
});

function evidenceOf(a: {
  leaseId: string;
  attemptId: string;
  fence: number;
  progressSeq: number;
}) {
  return {
    leaseId: a.leaseId,
    attemptId: a.attemptId,
    fence: a.fence,
    progressSeq: a.progressSeq,
  };
}
