import { describe, expect, it } from 'vitest';
import { officeRunnerEngine } from '../../src/adapters/office/engine.js';
import { createOfficeReviewGuard } from '../../src/adapters/office/ledger.js';
import { parseOfficeReceipt } from '../../src/adapters/office/receipt.js';
import type { RunnerEngine } from '../../src/runner/engine.js';
import { type PollReport, TowerRunner } from '../../src/runner/runner.js';
import {
  createMemoryStateStore,
  type StateStore,
} from '../../src/runner/state.js';
import { type Transport, TransportError } from '../../src/runner/transport.js';
import { FakeOfficeEngine, FakeWorld } from '../adapters/office/fake-engine.js';
import {
  createFleetHarness,
  DIGEST,
  type FleetHarness,
  VERSION,
} from '../fleet/helpers.js';
import { TEST_WORKSPACE } from '../helpers/tower.js';

const STEPS = 3;

function transportOver(
  h: FleetHarness,
  options: { loseReceipts?: number } = {},
): Transport {
  let lost = options.loseReceipts ?? 0;
  return async ({ method, path, body, token }) => {
    if (lost > 0 && path.endsWith('/receipts')) {
      lost -= 1;
      throw new TransportError('the receipt was lost on the way');
    }
    return h.call(token, method, path, body);
  };
}

function runnerOver(
  transport: Transport,
  store: StateStore,
  engine: RunnerEngine,
): TowerRunner {
  return new TowerRunner({
    transport,
    engine,
    store,
    binding: { version: VERSION, buildDigest: DIGEST },
  });
}

/** Enrolls a new runner through the human route and registers it with its own store. */
async function enrollRunner(
  h: FleetHarness,
  store: StateStore,
  engine: RunnerEngine,
  transport: Transport = transportOver(h),
): Promise<TowerRunner> {
  const enrolled = await h.enroll({ maxConcurrent: 1 });
  expect(enrolled.status).toBe(201);
  const runner = runnerOver(transport, store, engine);
  await runner.register(enrolled.body.enrollment.token);
  return runner;
}

function office(
  world: FakeWorld,
  options: ConstructorParameters<typeof FakeOfficeEngine>[1] = {},
) {
  return officeRunnerEngine(
    new FakeOfficeEngine(world, { steps: STEPS, ...options }),
  );
}

function leasesFor(h: FleetHarness) {
  return h.fleet.leases(TEST_WORKSPACE, { status: undefined, limit: 100 });
}

describe('two tower-runner instances against one server', () => {
  it('the first runner claims and completes, and the second picks up the other packet', async () => {
    const h = createFleetHarness();
    const mission = h.mission([
      { title: 'A', scope: ['repo:a'] },
      { title: 'B', scope: ['repo:b'] },
    ]);
    const world = new FakeWorld();
    const storeOne = createMemoryStateStore();
    const storeTwo = createMemoryStateStore();
    const first = await enrollRunner(h, storeOne, office(world));
    const second = await enrollRunner(h, storeTwo, office(world));

    // The first runner is still busy when the second polls. Affinity would send the second packet
    // back to the first runner once it is idle, so the second must poll while the first is running.
    const firstPoll: PollReport = await first.pollOnce();
    expect(firstPoll.started).toHaveLength(1);
    const secondPoll: PollReport = await second.pollOnce();
    expect(secondPoll.started).toHaveLength(1);
    expect(secondPoll.started).not.toEqual(firstPoll.started);
    await first.drain();
    await second.drain();

    const state = h.getMission(mission.id);
    expect(state.packets.map((p) => p.status)).toEqual([
      'reported',
      'reported',
    ]);
    const holders = leasesFor(h).map((lease) => lease.runnerId);
    expect(new Set(holders).size).toBe(2);
    expect(world.applied).toHaveLength(2 * STEPS);
    expect(world.replays).toBe(0);
    expect(storeOne.load()?.leases).toEqual({});
    expect(storeTwo.load()?.leases).toEqual({});
  });

  it('killing a runner mid-run, then reconnecting, reconciles without duplicate mutable work', async () => {
    const h = createFleetHarness();
    const mission = h.mission([
      { title: 'A', scope: ['repo:a'] },
      { title: 'B', scope: ['repo:b'] },
    ]);
    const world = new FakeWorld();
    const storeOne = createMemoryStateStore();

    // The first runner stalls after step 2's mutation, before its progress is reported.
    const stalled = new FakeOfficeEngine(world, {
      steps: STEPS,
      stallAfterMutation: { step: 2 },
    });
    const first = await enrollRunner(h, storeOne, officeRunnerEngine(stalled));
    await first.pollOnce();
    // The lease the first runner held before it was killed.
    const stalledLeaseId = Object.values(storeOne.load()?.leases ?? {})[0]
      ?.leaseId;
    expect(stalledLeaseId).toBeDefined();
    await stalled.stallReached;
    // The process is gone. Nothing else is called on `first`, and its job never finishes.

    // Its lease expires with no evidence, so the lease moves to recovery.
    h.clock.advance(61_000);

    const storeTwo = createMemoryStateStore();
    const second = await enrollRunner(h, storeTwo, office(world));
    const secondPoll = await second.pollOnce();
    // The recovering lease is not reassigned yet. The second runner gets only the other packet.
    expect(secondPoll.started).toHaveLength(1);
    const otherPacket = secondPoll.started[0];
    await second.drain();
    expect(leasesFor(h).filter((l) => l.status === 'recovering')).toHaveLength(
      1,
    );

    // The first runner comes back on the same state, and reconciles before it does anything else.
    const restarted = new TowerRunner({
      transport: transportOver(h),
      engine: office(world),
      store: storeOne,
      binding: { version: VERSION, buildDigest: DIGEST },
    });
    restarted.start();
    const back = await restarted.pollOnce();
    expect(back.reconciled).toHaveLength(1);
    await restarted.drain();

    const state = h.getMission(mission.id);
    expect(state.packets.map((p) => p.status)).toEqual([
      'reported',
      'reported',
    ]);
    // Every step ran once. Step 2 ran before the crash and again after reconcile, and the second
    // run was a replay of a key already applied, not a second change.
    expect(world.applied).toHaveLength(2 * STEPS);
    expect(new Set(world.applied).size).toBe(2 * STEPS);
    expect(world.replays).toBe(1);
    expect(otherPacket).toBeDefined();

    const detail = h.fleet.leaseDetail(TEST_WORKSPACE, stalledLeaseId ?? '', {
      principalId: 'owner',
      kind: 'human',
    });
    expect(detail.progress.map((p) => p.seq)).toEqual([1, 2, 3]);
    expect(detail.receipts).toHaveLength(1);
    expect(storeOne.load()?.leases).toEqual({});
  });

  it('a receipt lost on the way is resent unchanged after a restart, and is recorded once', async () => {
    const h = createFleetHarness();
    const mission = h.mission([{ title: 'A', scope: ['repo:a'] }]);
    const world = new FakeWorld();
    const store = createMemoryStateStore();
    const engine = new FakeOfficeEngine(world, { steps: STEPS });

    const lossy = await enrollRunner(
      h,
      store,
      officeRunnerEngine(engine),
      transportOver(h, { loseReceipts: 1 }),
    );
    await lossy.pollOnce();
    await lossy.drain();
    // The receipt was not delivered, so the lease is still owed a receipt.
    const owed = Object.values(store.load()?.leases ?? {});
    expect(owed).toHaveLength(1);
    const owedReceiptId = owed[0]?.receipt?.receiptId;
    expect(owedReceiptId).toBeDefined();
    expect(owed[0]?.phase).toBe('finishing');
    expect(h.getMission(mission.id).packets[0]?.status).not.toBe('reported');

    const restarted = runnerOver(
      transportOver(h),
      store,
      officeRunnerEngine(engine),
    );
    restarted.start();
    const report = await restarted.pollOnce();
    expect(report.receiptsSent).toHaveLength(1);

    expect(engine.runs).toHaveLength(1);
    expect(world.applied).toHaveLength(STEPS);
    expect(h.getMission(mission.id).packets[0]?.status).toBe('reported');
    const lease = leasesFor(h)[0];
    const detail = h.fleet.leaseDetail(TEST_WORKSPACE, lease?.id ?? '', {
      principalId: 'owner',
      kind: 'human',
    });
    expect(detail.receipts).toHaveLength(1);
    // The resent receipt is the one that was owed, unchanged.
    expect(detail.receipts[0]?.receiptId).toBe(owedReceiptId);
  });

  it('the evidence Tower stored parses as a receipt, and the ledger and guard judge it', async () => {
    const h = createFleetHarness();
    const mission = h.mission([{ title: 'A', scope: ['repo:a'] }]);
    const world = new FakeWorld();
    const store = createMemoryStateStore();
    // The engine's executor reports its own green tests, and a second session reviews the work.
    const engine = officeRunnerEngine(
      new FakeOfficeEngine(world, {
        steps: STEPS,
        reviewer: 'reviewer-session',
      }),
    );
    const runner = await enrollRunner(h, store, engine);
    await runner.pollOnce();
    await runner.drain();

    const attempt = h.getMission(mission.id).attempts[0];
    const lease = leasesFor(h)[0];
    const detail = h.fleet.leaseDetail(TEST_WORKSPACE, lease?.id ?? '', {
      principalId: 'owner',
      kind: 'human',
    });
    const receipt = parseOfficeReceipt(detail.receipts[0]?.evidence);
    expect(receipt.receiptId).toMatch(/^office\./);

    // The receipt route recorded the verdict, with no manual ingest in the test.
    const rows = h.db.all<{
      independent_review: string;
      integrated_verification: string;
      attempt_id: string;
    }>(
      'SELECT independent_review, integrated_verification, attempt_id FROM office_receipts WHERE workspace_id = ?',
      [TEST_WORKSPACE],
    );
    expect(rows).toEqual([
      expect.objectContaining({
        attempt_id: attempt?.id,
        independent_review: 'satisfied',
        integrated_verification: 'passed',
      }),
    ]);

    const state = h.getMission(mission.id);
    const verdict = createOfficeReviewGuard(h.db).check({
      mission: { ...state, risk: 'high' },
    });
    expect(verdict).toEqual({ ok: true });
  });
});
