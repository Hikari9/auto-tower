import { describe, expect, it } from 'vitest';
import { openSqliteDatabase } from '../../src/storage/sqlite.js';
import {
  openTestDatabase,
  TEST_WORKSPACE,
  tempDbPath,
} from '../helpers/tower.js';
import {
  auditKinds,
  clientFor,
  createFleetHarness,
  evidence,
  type FleetHarness,
  type RunnerClient,
} from './helpers.js';

const TTL = 60_000;
const GRACE = 120_000;
const SHA = 'c'.repeat(40);

interface Held {
  leaseId: string;
  attemptId: string;
  fence: number;
  missionId: string;
  packetId: string;
}

/** A mission whose one packet is dispatched to `runner` and claimed. */
async function hold(
  h: FleetHarness,
  runner: RunnerClient,
  scope: string[] = ['repo:app'],
): Promise<Held> {
  const { id } = h.mission([{ scope }]);
  const res = await runner.claim();
  const a = res.body.assignments.find(
    (x: { missionId: string }) => x.missionId === id,
  );
  if (a === undefined) {
    throw new Error(`nothing claimed: ${JSON.stringify(res.body)}`);
  }
  return {
    leaseId: a.leaseId,
    attemptId: a.attemptId,
    fence: a.fence,
    missionId: id,
    packetId: a.packetId,
  };
}

function lease(h: FleetHarness, id: string) {
  // biome-ignore lint/suspicious/noExplicitAny: raw row
  return h.db.get<any>('SELECT * FROM runner_leases WHERE id = ?', [id]);
}

function rejections(h: FleetHarness, kind: string) {
  return h.fleet
    .audit(TEST_WORKSPACE, { afterSeq: 0, limit: 500 })
    .filter((r) => r.kind === kind);
}

describe('exactly one live lease per execution scope', () => {
  it('refuses the database a second live lease for a scope', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    const held = await hold(h, runner);
    expect(() =>
      h.db.run(
        `INSERT INTO runner_leases (workspace_id, id, scope_key, fence, attempt_id, mission_id, packet_id, runner_id, status,
           granted_at, expires_at, last_proof_at) VALUES (?, 'lse_x', 'repo:app#worktree:default', 99, 'att_x', 'm', 'p', ?, 'held', 'a', 'b', 'c')`,
        [TEST_WORKSPACE, runner.id],
      ),
    ).toThrow(/UNIQUE/);
    expect(lease(h, held.leaseId).status).toBe('held');
  });

  it('gives a concurrent double claim exactly one winner', async () => {
    const path = tempDbPath();
    const h = createFleetHarness({ db: openTestDatabase(path) });
    const other = h.connect(openSqliteDatabase(path));
    const a = await h.runner({ name: 'a' });
    const b0 = await h.runner({ name: 'b' });
    const b = clientFor(other.call, b0.id, b0.token);
    await a.claim();
    await b.claim();

    // Two packets on the same repo and worktree, dispatched to different runners.
    const { id } = h.mission([
      { scope: ['repo:app'] },
      { scope: ['repo:app'] },
    ]);
    h.tick();
    const attempts = h.getMission(id).attempts;
    expect(new Set(attempts.map((x) => x.runnerId))).toEqual(
      new Set([a.id, b.id]),
    );

    const [ra, rb] = await Promise.all([a.claim(), b.claim()]);
    const won = [...ra.body.assignments, ...rb.body.assignments];
    expect(won).toHaveLength(1);
    const loser = ra.body.assignments.length === 0 ? ra : rb;
    expect(loser.body.withheld[0].reason).toBe(
      'another runner holds the execution scope',
    );
    expect(
      h.db.all(
        "SELECT id FROM runner_leases WHERE status IN ('held','recovering')",
      ),
    ).toHaveLength(1);
  });

  it('makes the loser wait with bounded, growing backoff, then lets it in once the scope frees', async () => {
    const h = createFleetHarness({
      config: { backoff: { baseMs: 1_000, capMs: 4_000 } },
    });
    const a = await h.runner({ name: 'a' });
    const b = await h.runner({ name: 'b' });
    await a.claim();
    await b.claim();
    const { id } = h.mission([
      { scope: ['repo:app'] },
      { scope: ['repo:app'] },
    ]);
    h.tick();
    const [ra, rb] = await Promise.all([a.claim(), b.claim()]);
    const winner = ra.body.assignments.length === 1 ? a : b;
    const loser = winner === a ? b : a;
    const won = (winner === a ? ra : rb).body.assignments[0];
    const lost = (winner === a ? rb : ra).body;
    const backoff = () =>
      h.db.get<{ failures: number; not_before: string }>(
        'SELECT failures, not_before FROM runner_claim_backoff',
      );
    const delay = () =>
      Date.parse(backoff()?.not_before ?? '') - h.clock.now().getTime();
    expect(lost.retryAfterMs).toBe(1_000);
    expect(delay()).toBe(1_000);

    // Inside the backoff window the loser is not even tried.
    const early = await loser.claim();
    expect(early.body.withheld[0].reason).toMatch(/backing off/);
    expect(backoff()?.failures).toBe(1);

    const delays: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      h.clock.advance(delay() + 1);
      await winner.heartbeat([evidence(won)]);
      await loser.claim();
      delays.push(delay() + 0);
    }
    expect(backoff()?.failures).toBe(5);
    expect(Math.max(...delays)).toBeLessThanOrEqual(4_000);
    expect(delays.at(-1)).toBeGreaterThan(0);

    await winner.receipt(won.leaseId, {
      receiptId: 'r1',
      fence: won.fence,
      outcome: 'succeeded',
    });
    h.clock.advance(5_000);
    const next = await loser.claim();
    expect(next.body.assignments).toHaveLength(1);
    // The fence is per scope: the second lease on it is the second token.
    expect(next.body.assignments[0].fence).toBe(2);
    expect(h.db.get('SELECT 1 FROM runner_claim_backoff')).toBeUndefined();
    expect(id).toBeTruthy();
  });
});

describe('fencing', () => {
  it('rejects and records progress, checkpoints and receipts that carry an old fencing token', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    const held = await hold(h, runner);
    expect(
      (
        await runner.progress(held.leaseId, {
          fence: 1,
          seq: 1,
          message: 'started',
        })
      ).status,
    ).toBe(201);

    h.clock.advance(TTL + 1_000);
    // Expired: the same token is no good any more.
    const late = await runner.progress(held.leaseId, {
      fence: 1,
      seq: 2,
      message: 'late',
    });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('lease_expired');

    // Back on the network: reconcile first, and the old token dies.
    const poll = await runner.claim();
    expect(
      poll.body.reconcile.map((l: { leaseId: string }) => l.leaseId),
    ).toEqual([held.leaseId]);
    expect(poll.body.assignments).toEqual([]);
    const back = await runner.reconcile(held.leaseId, 1);
    expect(back.status).toBe(200);
    expect(back.body.lease.fence).toBe(2);
    expect(back.body.resume.progressSeq).toBe(1);

    const stale = [
      await runner.progress(held.leaseId, {
        fence: 1,
        seq: 2,
        message: 'old token',
      }),
      await runner.checkpoint(held.leaseId, {
        fence: 1,
        ref: 'refs/heads/x',
        commit: SHA,
      }),
      await runner.receipt(held.leaseId, {
        receiptId: 'r-old',
        fence: 1,
        outcome: 'succeeded',
      }),
    ];
    for (const res of stale) {
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('lease_fenced');
    }
    expect(rejections(h, 'progress.rejected')).toHaveLength(2);
    expect(rejections(h, 'checkpoint.rejected')).toHaveLength(1);
    expect(rejections(h, 'receipt.rejected')).toHaveLength(1);
    expect(rejections(h, 'receipt.rejected')[0]?.detail).toMatchObject({
      presentedFence: 1,
      currentFence: 2,
    });
    // Nothing from the stale calls was stored or reported.
    expect(h.db.all('SELECT seq FROM runner_progress')).toHaveLength(1);
    expect(h.db.all('SELECT id FROM runner_checkpoints')).toHaveLength(0);
    expect(h.db.all('SELECT receipt_id FROM runner_receipts')).toHaveLength(0);
    expect(h.getMission(held.missionId).attempts[0]?.status).toBe('running');

    // The new token works.
    expect(
      (
        await runner.progress(held.leaseId, {
          fence: 2,
          seq: 2,
          message: 'resumed',
        })
      ).status,
    ).toBe(201);
  });

  it('answers a retried reconcile after a lost response', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    const held = await hold(h, runner);
    h.clock.advance(TTL + 1_000);
    await runner.claim();
    const first = await runner.reconcile(held.leaseId, 1);
    const retry = await runner.reconcile(held.leaseId, 1);
    expect(retry.status).toBe(200);
    expect(retry.body.lease.fence).toBe(first.body.lease.fence);
    // A token that never existed is still refused.
    expect((await runner.reconcile(held.leaseId, 7)).status).toBe(409);
  });

  it('refuses another runner a lease that is not its own', async () => {
    const h = createFleetHarness();
    const a = await h.runner({ name: 'a' });
    const b = await h.runner({ name: 'b' });
    const held = await hold(h, a);
    const res = await b.progress(held.leaseId, {
      fence: held.fence,
      seq: 1,
      message: 'mine now',
    });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('lease_not_found');
    expect(
      (
        await b.receipt(held.leaseId, {
          receiptId: 'x',
          fence: held.fence,
          outcome: 'succeeded',
        })
      ).status,
    ).toBe(404);
    expect(rejections(h, 'progress.rejected')).toHaveLength(1);
  });

  it('keeps progress ordered and idempotent', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    const held = await hold(h, runner);
    const body = { fence: 1, seq: 1, message: 'one', data: { pct: 10 } };
    expect((await runner.progress(held.leaseId, body)).status).toBe(201);
    const again = await runner.progress(held.leaseId, body);
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(
      (await runner.progress(held.leaseId, { ...body, message: 'changed' }))
        .status,
    ).toBe(409);
    expect(
      (await runner.progress(held.leaseId, { ...body, seq: 3 })).status,
    ).toBe(409);
    expect(h.db.all('SELECT seq FROM runner_progress')).toHaveLength(1);
  });
});

describe('receipts', () => {
  it('reports the attempt to the core once, and treats a duplicate receipt as idempotent', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    const held = await hold(h, runner);
    const body = {
      receiptId: 'rcp-1',
      fence: 1,
      outcome: 'succeeded',
      summary: 'built it',
      evidence: { tests: 12 },
    };
    const first = await runner.receipt(held.leaseId, body);
    expect(first.status).toBe(201);
    expect(first.body.replayed).toBe(false);

    const state = h.getMission(held.missionId);
    expect(state.attempts[0]).toMatchObject({
      status: 'self-reported-succeeded',
      report: { by: runner.id, summary: 'built it' },
    });
    expect(state.packets[0]?.status).toBe('reported');
    expect(lease(h, held.leaseId).status).toBe('completed');

    const dup = await runner.receipt(held.leaseId, body);
    expect(dup.status).toBe(200);
    expect(dup.body.replayed).toBe(true);
    expect(
      h.db.all("SELECT seq FROM events WHERE type = 'attempt.reported'"),
    ).toHaveLength(1);
    expect(h.db.all('SELECT receipt_id FROM runner_receipts')).toHaveLength(1);

    const conflict = await runner.receipt(held.leaseId, {
      ...body,
      summary: 'something else',
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('receipt_conflict');
    // A different receipt for an attempt that is already closed is refused too.
    const another = await runner.receipt(held.leaseId, {
      ...body,
      receiptId: 'rcp-2',
    });
    expect(another.status).toBe(409);
    expect(
      h.db.all("SELECT seq FROM events WHERE type = 'attempt.reported'"),
    ).toHaveLength(1);
  });

  it("does not let one runner replay another runner's receipt id as its own", async () => {
    const h = createFleetHarness();
    const a = await h.runner({ name: 'a' });
    const b = await h.runner({ name: 'b' });
    const held = await hold(h, a);
    await a.receipt(held.leaseId, {
      receiptId: 'same',
      fence: 1,
      outcome: 'succeeded',
    });
    const res = await b.receipt(held.leaseId, {
      receiptId: 'same',
      fence: 1,
      outcome: 'succeeded',
    });
    expect(res.status).toBe(404);
  });

  it('records a failed outcome as a failed packet, never as verified', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    const held = await hold(h, runner);
    await runner.receipt(held.leaseId, {
      receiptId: 'r',
      fence: 1,
      outcome: 'failed',
      summary: 'tests red',
    });
    const state = h.getMission(held.missionId);
    expect(state.packets[0]?.status).toBe('failed');
    expect(state.packets[0]?.verification).toBeNull();
  });
});

describe('missed heartbeats', () => {
  it('move the attempt to recovery and not to failed', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    const held = await hold(h, runner);
    h.clock.advance(TTL + 1_000);
    h.fleet.sweep(TEST_WORKSPACE);

    expect(lease(h, held.leaseId).status).toBe('recovering');
    const state = h.getMission(held.missionId);
    expect(state.attempts[0]?.status).toBe('running');
    expect(state.packets[0]?.status).toBe('running');
    expect(state.state).not.toBe('needs-attention');
    expect(auditKinds(h)).toContain('lease.recovering');
  });

  it('makes the original runner reconcile first, before it gets any new work', async () => {
    const h = createFleetHarness();
    const runner = await h.runner({ maxConcurrent: 3 });
    const held = await hold(h, runner, ['repo:one']);
    await runner.progress(held.leaseId, {
      fence: 1,
      seq: 1,
      message: 'under way',
    });
    h.clock.advance(TTL + 1_000);
    h.mission([{ scope: ['repo:two'] }]);

    const poll = await runner.claim();
    expect(poll.body.assignments).toEqual([]);
    expect(poll.body.reconcile).toHaveLength(1);
    await runner.reconcile(held.leaseId, 1);
    // It now holds the lease on fence 2 and shows it, so the only new thing to send is the second packet.
    const next = await runner.claim({
      active: [evidence({ ...held, fence: 2, progressSeq: 1 })],
    });
    expect(next.body.assignments).toHaveLength(1);
    expect(next.body.assignments[0].scopeKey).toBe('repo:two#worktree:default');
  });

  it('keeps a lease alive only on matching attempt evidence', async () => {
    const h = createFleetHarness();
    const a = await h.runner({ name: 'a' });
    const b = await h.runner({ name: 'b' });
    const held = await hold(h, a, ['repo:one']);
    const theirs = await hold(h, b, ['repo:two']);
    const before = lease(h, held.leaseId);

    const bogus = [
      {
        leaseId: 'lse_nonexistent',
        attemptId: held.attemptId,
        fence: 1,
        progressSeq: 0,
      },
      evidence({ ...theirs }),
      evidence({ ...held, fence: 9 }),
      evidence({ ...held, progressSeq: 5 }),
      evidence({ ...held, attemptId: 'att_other' }),
    ];
    for (let i = 0; i < 2; i += 1) {
      h.clock.advance(TTL / 3);
      const res = await a.heartbeat(bogus);
      expect(res.body.leases).toEqual([]);
      expect(
        res.body.unmatched.map((u: { reason: string }) => u.reason),
      ).toEqual([
        'unknown lease',
        'unknown lease',
        'stale fencing token',
        'claims progress that Tower has not recorded',
        'attempt does not match the lease',
      ]);
    }
    // Alive, heartbeating, and still without proof of work: the lease ran out anyway.
    h.clock.advance(TTL / 3 + 1_000);
    h.fleet.sweep(TEST_WORKSPACE);
    expect(lease(h, held.leaseId).status).toBe('recovering');
    expect(lease(h, held.leaseId).last_proof_at).toBe(before.last_proof_at);
    expect(rejections(h, 'heartbeat.unmatched')).toHaveLength(10);
    // The other runner's lease was not touched by a's claim on it.
    expect(lease(h, theirs.leaseId).last_proof_at).toBe(
      lease(h, theirs.leaseId).granted_at,
    );
  });

  it('renews a lease on matching evidence, and a bare poll is not evidence', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    const held = await hold(h, runner);

    for (let i = 0; i < 4; i += 1) {
      h.clock.advance(TTL / 2);
      const res = await runner.heartbeat([evidence(held)]);
      expect(res.body.leases).toHaveLength(1);
      expect(res.body.unmatched).toEqual([]);
    }
    expect(lease(h, held.leaseId).status).toBe('held');

    h.clock.advance(TTL / 2);
    await runner.claim(); // polls often, shows nothing
    h.clock.advance(TTL);
    await runner.claim();
    expect(lease(h, held.leaseId).status).toBe('recovering');
  });
});

describe('reassignment', () => {
  async function stranded(h: FleetHarness, withCheckpoint: boolean) {
    const a = await h.runner({ name: 'a' });
    const b = await h.runner({ name: 'b' });
    const held = await hold(h, a);
    await a.progress(held.leaseId, { fence: 1, seq: 1, message: 'halfway' });
    if (withCheckpoint) {
      const cp = await a.checkpoint(held.leaseId, {
        fence: 1,
        ref: 'refs/heads/tower/att',
        commit: SHA,
      });
      expect(cp.status).toBe(201);
    }
    return { a, b, held };
  }

  it('waits when no portable checkpoint was recorded', async () => {
    const h = createFleetHarness();
    const { b, held } = await stranded(h, false);
    for (const wait of [TTL + 1_000, GRACE + 1_000, 60 * 60_000]) {
      h.clock.advance(wait);
      const res = await b.claim();
      expect(res.body.assignments).toEqual([]);
    }
    expect(lease(h, held.leaseId).status).toBe('recovering');
    expect(
      h.db.all("SELECT id FROM runner_leases WHERE status = 'held'"),
    ).toHaveLength(0);
    expect(h.getMission(held.missionId).attempts[0]?.runnerId).not.toBe(b.id);
  });

  it('waits out the grace period even with a checkpoint', async () => {
    const h = createFleetHarness();
    const { b, held } = await stranded(h, true);
    h.clock.advance(TTL + 1_000);
    expect((await b.claim()).body.assignments).toEqual([]);
    expect(lease(h, held.leaseId).status).toBe('recovering');
  });

  it('moves the work to another runner from the checkpoint and fences the old attempt', async () => {
    const h = createFleetHarness();
    const { a, b, held } = await stranded(h, true);
    h.clock.advance(TTL + GRACE + 1_000);
    const res = await b.claim();
    expect(res.body.assignments).toHaveLength(1);
    const next = res.body.assignments[0];
    expect(next).toMatchObject({
      attemptId: held.attemptId,
      fence: 2,
      resume: {
        progressSeq: 1,
        checkpoint: { ref: 'refs/heads/tower/att', commit: SHA },
      },
    });
    expect(lease(h, held.leaseId)).toMatchObject({
      status: 'fenced',
      close_reason: 'reassigned to another runner',
    });
    expect(auditKinds(h)).toContain('lease.reassigned');
    // Sent again until b shows evidence for it, then not.
    expect((await b.claim()).body.assignments[0]?.leaseId).toBe(next.leaseId);
    expect(
      (await b.claim({ active: [evidence(next)] })).body.assignments,
    ).toEqual([]);

    // The old runner comes back and is turned away on every path.
    const old = [
      await a.reconcile(held.leaseId, 1),
      await a.progress(held.leaseId, { fence: 1, seq: 2, message: 'zombie' }),
      await a.checkpoint(held.leaseId, {
        fence: 1,
        ref: 'refs/heads/zombie',
        commit: SHA,
      }),
      await a.receipt(held.leaseId, {
        receiptId: 'z',
        fence: 1,
        outcome: 'succeeded',
      }),
    ];
    for (const r of old) {
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('lease_fenced');
    }
    const hb = await a.heartbeat([evidence(held)]);
    expect(hb.body.unmatched[0].reason).toBe('lease is fenced');
    expect((await a.claim()).body.assignments).toEqual([]);

    // The new holder carries on and reports. The core only lets the dispatched runner report, so Tower relays.
    expect(
      (
        await b.progress(next.leaseId, {
          fence: 2,
          seq: 2,
          message: 'finishing',
        })
      ).status,
    ).toBe(201);
    const done = await b.receipt(next.leaseId, {
      receiptId: 'b-1',
      fence: 2,
      outcome: 'succeeded',
      summary: 'done',
    });
    expect(done.status).toBe(201);
    const attempt = h.getMission(held.missionId).attempts[0];
    expect(attempt?.status).toBe('self-reported-succeeded');
    expect(attempt?.report?.by).toBe(`prn_fleet_${TEST_WORKSPACE}`);
    expect(attempt?.report?.summary).toBe(`[runner ${b.id}] done`);
    expect(h.getMission(held.missionId).packets[0]?.status).toBe('reported');
  });

  it('never reassigns from a quarantined runner', async () => {
    const h = createFleetHarness();
    const { a, b, held } = await stranded(h, true);
    await h.call(h.owner.token, 'POST', `/runners/${a.id}/quarantine`, {
      reason: 'suspect',
    });
    expect(lease(h, held.leaseId).status).toBe('recovering');
    const res = await a.progress(held.leaseId, {
      fence: 1,
      seq: 2,
      message: 'x',
    });
    expect(res.status).toBe(403);
    expect(rejections(h, 'runner.rejected')).toHaveLength(1);

    h.clock.advance(TTL + GRACE + 1_000);
    expect((await b.claim()).body.assignments).toEqual([]);
    expect(lease(h, held.leaseId).status).toBe('recovering');
  });

  it('backs off, with a cap, while no other runner is eligible', async () => {
    const h = createFleetHarness({
      config: { backoff: { baseMs: 1_000, capMs: 4_000 } },
    });
    const a = await h.runner({ name: 'a', allowedScopes: ['repo:app'] });
    // b cannot take the scope, so nobody can.
    const b = await h.runner({ name: 'b', allowedScopes: ['repo:other'] });
    const held = await hold(h, a);
    await a.checkpoint(held.leaseId, {
      fence: 1,
      ref: 'refs/heads/t',
      commit: SHA,
    });
    h.clock.advance(TTL + GRACE + 1_000);

    const seen: Array<{ failures: number; wait: number }> = [];
    for (let i = 0; i < 6; i += 1) {
      await b.claim();
      const row = lease(h, held.leaseId);
      seen.push({
        failures: row.reassign_failures,
        wait: Date.parse(row.reassign_not_before) - h.clock.now().getTime(),
      });
      // Polling again before the wait is up changes nothing.
      await b.claim();
      expect(lease(h, held.leaseId).reassign_failures).toBe(
        row.reassign_failures,
      );
      h.clock.advance(
        Date.parse(row.reassign_not_before) - h.clock.now().getTime() + 1,
      );
    }
    expect(seen.map((s) => s.wait)).toEqual([
      1_000, 2_000, 4_000, 4_000, 4_000, 4_000,
    ]);
    expect(seen.map((s) => s.failures)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(lease(h, held.leaseId).status).toBe('recovering');
  });
});

describe('cancel and pause are honoured', () => {
  it('closes the lease when the mission is cancelled, tells the runner, and frees the scope', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    const held = await hold(h, runner);
    const mission = h.getMission(held.missionId);
    h.core.missions.cancelMission(
      h.ctx(),
      mission.id,
      mission.version,
      'no longer needed',
    );

    const hb = await runner.heartbeat([evidence(held)]);
    expect(hb.body.unmatched).toEqual([
      { leaseId: held.leaseId, reason: 'lease is cancelled', cancel: true },
    ]);
    expect(lease(h, held.leaseId).status).toBe('cancelled');

    const late = await runner.progress(held.leaseId, {
      fence: 1,
      seq: 1,
      message: 'still going',
    });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('attempt_cancelled');
    expect(
      (
        await runner.receipt(held.leaseId, {
          receiptId: 'c',
          fence: 1,
          outcome: 'succeeded',
        })
      ).status,
    ).toBe(409);
    expect(h.getMission(held.missionId).attempts[0]?.status).toBe('cancelled');
    expect(h.db.all('SELECT receipt_id FROM runner_receipts')).toHaveLength(0);

    // The scope is free for the next mission.
    h.mission([{ scope: ['repo:app'] }]);
    expect((await runner.claim()).body.assignments).toHaveLength(1);
  });

  it('frees the scope of a cancelled mission even when its runner never comes back', async () => {
    const h = createFleetHarness();
    const a = await h.runner({ name: 'a' });
    const b = await h.runner({ name: 'b' });
    const held = await hold(h, a);
    const mission = h.getMission(held.missionId);
    h.core.missions.cancelMission(h.ctx(), mission.id, mission.version, null);
    h.mission([{ scope: ['repo:app'] }]);
    // a is silent, so b is the only runner the broker will offer work to.
    h.clock.advance(h.config.livenessWindowMs + 1_000);
    expect((await b.claim()).body.assignments).toHaveLength(1);
  });

  it('tells a runner to pause when its mission is waiting on something external, and sends it nothing new', async () => {
    const h = createFleetHarness();
    const runner = await h.runner({ maxConcurrent: 3 });
    const held = await hold(h, runner, ['repo:one']);
    const second = h.mission([{ scope: ['repo:two'] }]);
    h.tick(); // dispatched, not yet collected

    for (const id of [held.missionId, second.id]) {
      const m = h.getMission(id);
      h.core.missions.transitionMission(
        h.ctx(),
        id,
        m.version,
        'waiting-external',
        'blocked',
      );
    }
    const res = await runner.claim({ active: [evidence(held)] });
    expect(res.body.leases[0].directives).toEqual({
      cancel: false,
      pause: true,
    });
    expect(res.body.assignments).toEqual([]);
    expect(res.body.withheld[0].reason).toBe('mission is waiting-external');
  });

  it('lets a human release a stuck lease, which fails the attempt and frees the scope', async () => {
    const h = createFleetHarness();
    const a = await h.runner({ name: 'a' });
    const b = await h.runner({ name: 'b' });
    const held = await hold(h, a);
    h.clock.advance(TTL + 1_000);
    expect((await b.claim()).body.assignments).toEqual([]); // no checkpoint: it waits

    expect(
      (await a.call('POST', `/runners/leases/${held.leaseId}/release`, {}))
        .status,
    ).toBe(403);
    const res = await h.call(
      h.owner.token,
      'POST',
      `/runners/leases/${held.leaseId}/release`,
      { reason: 'machine is gone' },
    );
    expect(res.status).toBe(200);
    expect(res.body.lease.status).toBe('released');
    const state = h.getMission(held.missionId);
    expect(state.attempts[0]?.status).toBe('self-reported-failed');
    expect(state.packets[0]?.status).toBe('failed');
    expect(
      (
        await h.call(
          h.owner.token,
          'POST',
          `/runners/leases/${held.leaseId}/release`,
          {},
        )
      ).status,
    ).toBe(409);
    h.mission([{ scope: ['repo:app'] }]);
    h.clock.advance(h.config.livenessWindowMs + 1_000);
    expect((await b.claim()).body.assignments).toHaveLength(1);
  });
});
