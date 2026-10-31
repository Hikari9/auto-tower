import { describe, expect, it } from 'vitest';
import { officeRunnerEngine } from '../../src/adapters/office/engine.js';
import { ClassifiedFailure } from '../../src/runner/failure.js';
import { TowerRunner } from '../../src/runner/runner.js';
import { createMemoryStateStore } from '../../src/runner/state.js';
import { FakeOfficeEngine, FakeWorld } from '../adapters/office/fake-engine.js';
import {
  createFleetHarness,
  DIGEST,
  type FleetHarness,
  VERSION,
} from '../fleet/helpers.js';
import { TEST_WORKSPACE } from '../helpers/tower.js';

function runnerFor(
  h: FleetHarness,
  store = createMemoryStateStore(),
  engine = officeRunnerEngine(
    new FakeOfficeEngine(new FakeWorld(), { steps: 2 }),
  ),
) {
  const transport = ({
    method,
    path,
    body,
    token,
  }: {
    method: 'GET' | 'POST';
    path: string;
    body?: unknown;
    token?: string;
  }) => h.call(token, method, path, body);
  return new TowerRunner({
    transport,
    engine,
    store,
    binding: { version: VERSION, buildDigest: DIGEST },
  });
}

async function enrolled(h: FleetHarness) {
  const enrollment = await h.enroll({ maxConcurrent: 1 });
  return enrollment.body.enrollment.token as string;
}

describe('TowerRunner', () => {
  it('refuses a second registration into the same state', async () => {
    const h = createFleetHarness();
    const store = createMemoryStateStore();
    await runnerFor(h, store).register(await enrolled(h));
    await expect(
      runnerFor(h, store).register(await enrolled(h)),
    ).rejects.toThrow(/already holds/);
  });

  it('refuses to poll before it is started', async () => {
    const h = createFleetHarness();
    await expect(runnerFor(h).pollOnce()).rejects.toThrow(/not started/);
  });

  it('does not start work on restart; running leases wait for reconcile', async () => {
    const h = createFleetHarness();
    h.mission([{ title: 'A', scope: ['repo:a'] }]);
    const store = createMemoryStateStore();
    const first = runnerFor(h, store);
    await first.register(await enrolled(h));
    await first.pollOnce();
    const restarted = runnerFor(h, store);
    restarted.start();
    const phases = Object.values(store.load()?.leases ?? {}).map(
      (l) => l.phase,
    );
    expect(phases).toEqual(['reconcile']);
  });

  it('lets go of a lease Tower cancels, and reports the reason', async () => {
    const h = createFleetHarness();
    const mission = h.mission([{ title: 'A', scope: ['repo:a'] }]);
    const store = createMemoryStateStore();
    const world = new FakeWorld();
    const stalled = new FakeOfficeEngine(world, {
      steps: 2,
      stallAfterMutation: { step: 1 },
    });
    const runner = runnerFor(h, store, officeRunnerEngine(stalled));
    await runner.register(await enrolled(h));
    await runner.pollOnce();
    await stalled.stallReached;

    h.core.missions.cancelMission(
      h.ctx(),
      mission.id,
      h.getMission(mission.id).version,
      'stop',
    );
    const report = await runner.pollOnce();
    expect(report.dropped.map((d) => d.reason)).toEqual(['cancelled by Tower']);
    expect(store.load()?.leases).toEqual({});
  });

  it('turns an engine that throws into a failed receipt with the class it named', async () => {
    const h = createFleetHarness();
    const mission = h.mission([{ title: 'A', scope: ['repo:a'] }]);
    const throwing = {
      run: async () => {
        throw new ClassifiedFailure(
          'environment',
          'the office binary is missing',
        );
      },
    };
    const store = createMemoryStateStore();
    const runner = runnerFor(h, store, throwing);
    await runner.register(await enrolled(h));
    await runner.pollOnce();
    await runner.drain();
    const packet = h.getMission(mission.id).packets[0];
    const attempt = h.getMission(mission.id).attempts[0];
    expect(attempt?.report?.outcome).toBe('failed');
    // A failed attempt puts its packet in `failed`, not `reported`.
    expect(packet?.status).toBe('failed');
    const lease = h.fleet.leases(TEST_WORKSPACE, {
      status: undefined,
      limit: 10,
    })[0];
    const detail = h.fleet.leaseDetail(TEST_WORKSPACE, lease?.id ?? '', {
      principalId: 'owner',
      kind: 'human',
    });
    expect(detail.receipts[0]?.evidence).toMatchObject({
      failureClass: 'environment',
    });
    expect(store.load()?.leases).toEqual({});
  });

  it('builds a claim body with the binding, capabilities, and only confirmed evidence', async () => {
    const h = createFleetHarness();
    h.mission([{ title: 'A', scope: ['repo:a'] }]);
    const seen: unknown[] = [];
    const transport = (req: {
      method: 'GET' | 'POST';
      path: string;
      body?: unknown;
      token?: string;
    }) => {
      if (req.path === '/runners/claims') {
        seen.push(req.body);
      }
      return h.call(req.token, req.method, req.path, req.body);
    };
    const enrollment = await h.enroll({ maxConcurrent: 1 });
    const runner = new TowerRunner({
      transport,
      engine: officeRunnerEngine(
        new FakeOfficeEngine(new FakeWorld(), { steps: 1 }),
      ),
      store: createMemoryStateStore(),
      binding: { version: VERSION, buildDigest: DIGEST },
      capabilities: ['cap:node'],
    });
    await runner.register(enrollment.body.enrollment.token);
    await runner.pollOnce();
    expect(seen[0]).toEqual({
      version: VERSION,
      buildDigest: DIGEST,
      capabilities: ['cap:node'],
      active: [],
    });
  });
});
