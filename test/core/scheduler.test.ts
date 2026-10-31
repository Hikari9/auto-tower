import { afterEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenActorError } from '../../src/core/errors.js';
import { deriveMissionState } from '../../src/core/scheduler.js';
import type { MissionState } from '../../src/core/types.js';
import { createEventLog } from '../../src/events/event-log.js';
import { openTestDatabase, TEST_WORKSPACE } from '../helpers/tower.js';
import {
  createHarness,
  type Harness,
  MissionDriver,
  mission,
  seedFixedPrincipal,
} from './helpers.js';

function readyMission(h: Harness) {
  const m = MissionDriver.create(h);
  m.go('ready');
  return m;
}

describe('waiting for a runner', () => {
  it('reports waiting-runner, never failed, when authorized work has no runner', () => {
    const h = createHarness();
    const m = readyMission(h);
    const a = m.addPacket('Build');
    m.authorize(a);

    const result = m.tick();

    expect(m.state.state).toBe('waiting-runner');
    expect(m.state.packets[0]?.status).toBe('ready');
    expect(m.state.attempts).toEqual([]);
    expect(result.changes).toEqual([
      expect.objectContaining({
        missionId: m.id,
        from: 'ready',
        to: 'waiting-runner',
        events: ['packet.readied', 'mission.transitioned'],
      }),
    ]);
    expect(
      h.core.missions.search(TEST_WORKSPACE, {
        states: ['needs-attention', 'cancelled'],
        limit: 10,
        offset: 0,
      }).total,
    ).toBe(0);
  });

  it('stays waiting-runner across any number of ticks and any amount of time', () => {
    const h = createHarness();
    const m = readyMission(h);
    m.authorize(m.addPacket('Build'));
    m.tick();

    for (let i = 0; i < 5; i += 1) {
      h.clock.advance(7 * 24 * 60 * 60 * 1000);
      expect(m.tick().changes).toEqual([]);
    }
    expect(m.state.state).toBe('waiting-runner');
  });

  it('claims the work automatically once a runner comes online', () => {
    const h = createHarness();
    const m = readyMission(h);
    const a = m.addPacket('Build');
    m.authorize(a);
    m.tick();
    expect(m.state.state).toBe('waiting-runner');

    h.pool.online = ['prn_runner'];
    const result = m.tick();

    expect(m.state.state).toBe('running');
    expect(m.state.packets[0]).toMatchObject({
      status: 'leased',
      activeAttemptId: m.state.attempts[0]?.id,
    });
    expect(m.state.attempts[0]).toMatchObject({
      number: 1,
      runnerId: 'prn_runner',
      status: 'leased',
    });
    expect(result.changes[0]?.events).toEqual([
      'attempt.dispatched',
      'mission.transitioned',
    ]);
  });

  it('does not dispatch work that is not authorized', () => {
    const h = createHarness();
    h.pool.online = ['prn_runner'];
    const m = readyMission(h);
    m.addPacket('Build');

    m.tick();

    expect(m.state.state).toBe('waiting-decision');
    expect(m.state.packets[0]?.status).toBe('pending');
    expect(m.state.attempts).toEqual([]);
  });

  it('resumes once the packet is authorized', () => {
    const h = createHarness();
    h.pool.online = ['prn_runner'];
    const m = readyMission(h);
    const a = m.addPacket('Build');
    m.tick();
    expect(m.state.state).toBe('waiting-decision');

    m.authorize(a);
    m.tick();

    expect(m.state.state).toBe('running');
  });
});

describe('dependencies and independent branches', () => {
  it('does not start a packet before its prerequisite is verified', () => {
    const h = createHarness();
    h.pool.online = ['prn_runner'];
    const m = readyMission(h);
    const a = m.addPacket('A');
    const b = m.addPacket('B', { dependsOn: [a] });
    m.authorize(a);
    m.authorize(b);

    m.tick();
    expect(m.state.packets.map((p) => p.status)).toEqual(['leased', 'pending']);

    m.runAttempt(a);
    m.tick();
    // Self-reported success is not enough to release B.
    expect(m.state.packets.map((p) => p.status)).toEqual([
      'reported',
      'pending',
    ]);

    m.verifyPacket(a);
    m.tick();
    expect(m.state.packets.map((p) => p.status)).toEqual([
      'verified',
      'leased',
    ]);
  });

  it('keeps an unrelated branch moving while another branch is blocked on a failure', () => {
    const h = createHarness();
    h.pool.online = ['prn_runner'];
    const m = readyMission(h);
    // Branch one: a1 -> a2. Branch two: b1 -> b2.
    const a1 = m.addPacket('a1');
    const a2 = m.addPacket('a2', { dependsOn: [a1] });
    const b1 = m.addPacket('b1');
    const b2 = m.addPacket('b2', { dependsOn: [b1] });
    for (const id of [a1, a2, b1, b2]) {
      m.authorize(id);
    }
    m.tick();
    m.runAttempt(a1, 'failed');
    m.tick();

    // a2 is stuck behind the failed a1, yet branch two proceeds untouched.
    const status = () =>
      Object.fromEntries(m.state.packets.map((p) => [p.title, p.status]));
    expect(status()).toMatchObject({
      a1: 'failed',
      a2: 'pending',
      b1: 'leased',
      b2: 'pending',
    });
    expect(m.state.state).toBe('running');

    m.runAttempt(b1);
    m.verifyPacket(b1);
    m.tick();
    expect(status()).toMatchObject({
      a1: 'failed',
      a2: 'pending',
      b1: 'verified',
      b2: 'leased',
    });
    m.runAttempt(b2);
    m.verifyPacket(b2);
    m.tick();

    // Only once nothing else can move does the mission ask for attention.
    expect(status()).toMatchObject({
      a1: 'failed',
      a2: 'pending',
      b1: 'verified',
      b2: 'verified',
    });
    expect(m.state.state).toBe('needs-attention');
  });

  it('lets a failed packet be requeued and the blocked branch finish', () => {
    const h = createHarness();
    h.pool.online = ['prn_runner'];
    const m = readyMission(h);
    const a1 = m.addPacket('a1');
    const a2 = m.addPacket('a2', { dependsOn: [a1] });
    m.authorize(a1);
    m.authorize(a2);
    m.tick();
    m.runAttempt(a1, 'failed');
    m.tick();
    expect(m.state.state).toBe('needs-attention');

    m.state = h.core.missions.requeuePacket(
      h.ctx(),
      m.id,
      m.state.version,
      a1,
    ).mission;
    // Requeue clears the authorization, so the packet waits for a new one.
    m.authorize(a1);
    m.go('ready');
    m.tick();

    expect(m.state.packets[0]).toMatchObject({ status: 'leased' });
    expect(m.state.attempts.map((a) => a.number)).toEqual([1, 2]);
  });

  it('moves to verifying once every required packet is verified, ignoring optional leftovers', () => {
    const h = createHarness();
    h.pool.online = ['prn_runner'];
    const m = readyMission(h);
    const a = m.addPacket('a');
    m.addPacket('optional', { required: false });
    m.authorize(a);
    m.tick();
    m.runAttempt(a);
    m.verifyPacket(a);
    m.tick();

    expect(m.state.state).toBe('verifying');
  });
});

describe('determinism and idempotence', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function scenario() {
    // Commands from people take their timestamps from the event log's recording time, so
    // the wall clock is frozen too. The scheduler's own stamps come from the injected clock.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-01T00:00:00.000Z'));
    const h = createHarness({ db: openTestDatabase() });
    const m = MissionDriver.create(h);
    m.go('ready');
    const a = m.addPacket('a');
    const b = m.addPacket('b', { dependsOn: [a] });
    const c = m.addPacket('c');
    for (const id of [a, b, c]) {
      m.authorize(id);
    }
    h.pool.online = ['prn_runner'];
    h.clock.advance(1_000);
    const first = h.core.scheduler.tick(TEST_WORKSPACE, h.owner);
    m.runAttempt(a);
    m.verifyPacket(a);
    h.clock.advance(60_000);
    const second = h.core.scheduler.tick(TEST_WORKSPACE, h.owner);
    return { h, m, first, second };
  }

  function history(h: Harness, missionId: string) {
    return createEventLog(h.db)
      .readStream(TEST_WORKSPACE, `mission:${missionId}`)
      .map(({ type, payload, actorId, correlationId, version }) => ({
        version,
        type,
        payload,
        actorId,
        correlationId,
      }));
  }

  it('produces identical events, ids and timestamps from two identical runs under the fake clock', () => {
    const one = scenario();
    const two = scenario();

    expect(two.first).toEqual(one.first);
    expect(two.second).toEqual(one.second);
    expect(history(two.h, two.m.id)).toEqual(history(one.h, one.m.id));
    expect(two.m.refresh()).toEqual(one.m.refresh());
  });

  it('stamps scheduler events with the injected clock, not the wall clock', () => {
    const { h, m, first } = scenario();
    expect(first.at).toBe('2026-03-01T00:00:01.000Z');
    const dispatched = m.state.attempts[0];
    expect(dispatched?.dispatchedAt).toBe('2026-03-01T00:00:01.000Z');
    expect(
      h.core.missions.getMission(TEST_WORKSPACE, m.id)?.attempts[0]
        ?.dispatchedAt,
    ).toBe('2026-03-01T00:00:01.000Z');
  });

  it('writes nothing on a second tick over unchanged state', () => {
    const h = createHarness();
    h.pool.online = ['prn_runner'];
    const m = readyMission(h);
    m.authorize(m.addPacket('a'));
    m.authorize(m.addPacket('b'));
    const first = m.tick();
    const eventsAfterFirst = history(h, m.id).length;
    const snapshot = structuredClone(m.state);

    const second = m.tick();
    const third = m.tick();

    expect(first.changes).toHaveLength(1);
    expect(second.changes).toEqual([]);
    expect(third.changes).toEqual([]);
    expect(history(h, m.id)).toHaveLength(eventsAfterFirst);
    expect(m.state).toEqual(snapshot);
  });

  it('serves missions most urgent first, then oldest first', () => {
    const h = createHarness();
    h.pool.online = ['prn_runner'];
    const low = MissionDriver.create(
      h,
      mission({ title: 'low', priority: 'low' }),
    );
    const normalA = MissionDriver.create(h, mission({ title: 'normalA' }));
    const urgent = MissionDriver.create(
      h,
      mission({ title: 'urgent', priority: 'urgent' }),
    );
    const normalB = MissionDriver.create(h, mission({ title: 'normalB' }));
    for (const m of [low, normalA, urgent, normalB]) {
      m.go('ready');
      m.authorize(m.addPacket('work'));
    }

    const result = h.core.scheduler.tick(TEST_WORKSPACE, h.owner);

    expect(result.changes.map((c) => c.missionId)).toEqual([
      urgent.id,
      normalA.id,
      normalB.id,
      low.id,
    ]);
  });

  it('only touches missions in its own workspace', () => {
    const h = createHarness();
    h.pool.online = ['prn_runner'];
    const other = seedFixedPrincipal(h.db, 'prn_other', 'human', 'ws_other');
    const foreign = h.core.missions.createMission(
      { workspaceId: 'ws_other', actor: other },
      mission(),
    );
    h.core.missions.transitionMission(
      { workspaceId: 'ws_other', actor: other },
      foreign.mission.id,
      1,
      'ready',
      null,
    );
    const m = readyMission(h);
    m.authorize(m.addPacket('a'));

    const result = h.core.scheduler.tick(TEST_WORKSPACE, h.owner);

    expect(result.changes.map((c) => c.missionId)).toEqual([m.id]);
  });

  it('refuses to run for a runner principal', () => {
    const h = createHarness();
    expect(() => h.core.scheduler.tick(TEST_WORKSPACE, h.runner)).toThrow(
      ForbiddenActorError,
    );
  });

  it('leaves draft, planning and terminal missions alone', () => {
    const h = createHarness();
    const draft = MissionDriver.create(h);
    draft.authorize(draft.addPacket('a'));
    const cancelled = MissionDriver.create(h);
    cancelled.go('cancelled');

    expect(h.core.scheduler.tick(TEST_WORKSPACE, h.owner).changes).toEqual([]);
  });
});

describe('scheduling scope', () => {
  it.each([
    ['planning', ['planning']],
    ['waiting-external', ['ready', 'waiting-external']],
    ['verifying', ['ready', 'verifying']],
    ['reconciling', ['ready', 'verifying', 'reconciling']],
    ['needs-attention', ['ready', 'needs-attention']],
  ] as const)(
    'does not touch a %s mission that has dispatchable work',
    (state, path) => {
      const h = createHarness();
      h.pool.online = ['prn_runner'];
      const m = MissionDriver.create(h);
      const a = m.addPacket('a');
      m.authorize(a);
      for (const step of path) {
        m.go(step);
      }
      const version = m.state.version;

      expect(h.core.scheduler.tick(TEST_WORKSPACE, h.owner).changes).toEqual(
        [],
      );
      expect(m.refresh()).toMatchObject({ version, state });
    },
  );

  it('does not touch a completed mission', () => {
    const h = createHarness();
    h.pool.online = ['prn_runner'];
    const m = MissionDriver.create(h);
    m.toVerifying();
    m.verifyOutcome();
    m.go('completed');
    expect(h.core.scheduler.tick(TEST_WORKSPACE, h.owner).changes).toEqual([]);
  });
});

describe('deriveMissionState', () => {
  const base = { packets: [] } as unknown as MissionState;
  const withPackets = (...statuses: Array<[string, boolean?]>): MissionState =>
    ({
      ...base,
      packets: statuses.map(([status, required = true], i) => ({
        id: `p${i}`,
        status,
        required,
        dependsOn: [],
        authorization: null,
      })),
    }) as unknown as MissionState;

  it('leaves a mission with no live packets alone', () => {
    expect(deriveMissionState(base)).toBeUndefined();
    expect(deriveMissionState(withPackets(['cancelled']))).toBeUndefined();
  });

  it('prefers work in flight over work waiting for a runner', () => {
    expect(deriveMissionState(withPackets(['running'], ['ready']))).toBe(
      'running',
    );
    expect(deriveMissionState(withPackets(['reported'], ['ready']))).toBe(
      'running',
    );
    expect(deriveMissionState(withPackets(['ready'], ['failed']))).toBe(
      'waiting-runner',
    );
  });

  it('asks for attention only when nothing can move', () => {
    expect(deriveMissionState(withPackets(['failed']))).toBe('needs-attention');
    expect(deriveMissionState(withPackets(['verified'], ['failed']))).toBe(
      'needs-attention',
    );
  });
});
