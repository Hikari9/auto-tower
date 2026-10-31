import { describe, expect, it } from 'vitest';
import { readyPacketDecision } from '../../src/core/commands.js';
import {
  CommandNotAllowedError,
  CompletionGuardFailedError,
  ForbiddenActorError,
  PacketNotFoundError,
  SelfVerificationError,
  ValidationError,
} from '../../src/core/errors.js';
import { createCore } from '../../src/core/index.js';
import { parseCreateMission } from '../../src/core/inputs.js';
import { applyEvent, MISSION_CHANGE_KEYS } from '../../src/core/reducer.js';
import { deriveMissionState } from '../../src/core/scheduler.js';
import { DEFAULT_MAX_EVENTS_PER_MISSION } from '../../src/core/service.js';
import type { MissionState, MissionStatus } from '../../src/core/types.js';
import { createEventLog } from '../../src/events/event-log.js';
import { TEST_WORKSPACE } from '../helpers/tower.js';
import {
  createHarness,
  type Harness,
  MissionDriver,
  mission,
  seedFixedPrincipal,
} from './helpers.js';

const WS = TEST_WORKSPACE;
const stream = (id: string) => `mission:${id}`;
const stored = (h: Harness, id: string) =>
  createEventLog(h.db).readStream(WS, stream(id));

function dispatched(h: Harness) {
  h.pool.online = ['prn_runner'];
  const m = MissionDriver.create(h);
  m.go('ready');
  const a = m.addPacket('A');
  m.authorize(a);
  m.tick();
  return { m, a };
}

describe('replayed history is never rewritten by later events', () => {
  it('returns the recorded payloads in the activity feed after a dependency is added', () => {
    const h = createHarness();
    const m = MissionDriver.create(
      h,
      mission({ constraints: ['c1'], policyRefs: ['p1'] }),
    );
    const a = m.addPacket('a');
    const b = m.addPacket('b', { dependsOn: [a] });
    const c = m.addPacket('c');
    m.state = h.core.missions.addDependency(
      h.ctx(),
      m.id,
      m.state.version,
      b,
      c,
    ).mission;
    m.state = h.core.missions.updateMission(h.ctx(), m.id, m.state.version, {
      constraints: ['c2'],
      policyRefs: ['p2'],
    }).mission;

    const recorded = stored(h, m.id).map((e) => e.payload);
    const feed = h.core.missions
      .activity(WS, m.id, { afterVersion: 0, limit: 100 })
      .items.map((i) => i.payload);
    h.core.missions.replayMission(WS, m.id);
    h.core.missions.replayMission(WS, m.id);

    expect(feed).toEqual(recorded);
    const addedB = feed.find(
      (p) => (p as { title?: string }).title === 'b',
    ) as { dependsOn: string[] };
    expect(addedB.dependsOn).toEqual([a]);
    expect(h.core.missions.replayMission(WS, m.id)).toEqual(m.state);
    expect(m.state.packets[1]?.dependsOn).toEqual([a, c]);
    expect(m.state.constraints).toEqual(['c2']);
  });

  it('keeps an idempotent first result unchanged by later events', () => {
    const h = createHarness();
    const ctx = h.ctx(h.owner, { idempotencyKey: 'pkt-key' });
    const m = MissionDriver.create(h);
    const first = h.core.missions.addPacket(ctx, m.id, 1, {
      title: 'a',
      instructions: '',
      scope: ['s'],
      required: true,
      dependsOn: [],
    });
    m.state = first.mission;
    const packetId = first.mission.packets[0]?.id ?? '';
    const b = m.addPacket('b');
    m.state = h.core.missions.addDependency(
      h.ctx(),
      m.id,
      m.state.version,
      packetId,
      b,
    ).mission;

    const repeat = h.core.missions.addPacket(ctx, m.id, 1, {
      title: 'a',
      instructions: '',
      scope: ['s'],
      required: true,
      dependsOn: [],
    });

    expect(repeat.replayed).toBe(true);
    expect(repeat.mission.version).toBe(2);
    expect(repeat.mission.packets).toHaveLength(1);
    expect(repeat.mission.packets[0]?.dependsOn).toEqual([]);
  });
});

describe('the event cap', () => {
  it('answers a retry of the command that reached the cap with its first result', () => {
    const h = createHarness({ maxEventsPerMission: 3 });
    const m = MissionDriver.create(h);
    m.go('planning');
    const ctx = h.ctx(h.owner, { idempotencyKey: 'last-one' });
    const first = h.core.missions.updateMission(ctx, m.id, 2, {
      title: 'fills it',
    });

    const repeat = h.core.missions.updateMission(ctx, m.id, 2, {
      title: 'fills it',
    });

    expect(repeat).toMatchObject({
      replayed: true,
      mission: { version: 3, title: 'fills it' },
    });
    expect(repeat.event.seq).toBe(first.event.seq);
    expect(() =>
      h.core.missions.updateMission(h.ctx(), m.id, 3, { title: 'new' }),
    ).toThrow(CommandNotAllowedError);
  });

  it('leaves a full mission to the scheduler untouched', () => {
    const h = createHarness({ maxEventsPerMission: 5 });
    h.pool.online = ['prn_runner'];
    const m = MissionDriver.create(h);
    m.go('ready');
    const a = m.addPacket('a');
    m.authorize(a);
    m.addPacket('b');
    expect(stored(h, m.id)).toHaveLength(5);
    expect(m.tick().changes).toEqual([]);
    expect(stored(h, m.id)).toHaveLength(5);
    expect(m.state.state).toBe('ready');
  });

  it('still lets a full mission be flagged for attention or cancelled, even from completed', () => {
    const h = createHarness({ maxEventsPerMission: 5 });
    const m = MissionDriver.create(h);
    m.go('ready');
    m.go('verifying');
    m.verifyOutcome();
    m.go('completed');
    expect(stored(h, m.id)).toHaveLength(5);

    m.go('needs-attention');
    expect(m.state.state).toBe('needs-attention');
    expect(
      h.core.missions.cancelMission(h.ctx(), m.id, m.state.version, null)
        .mission.state,
    ).toBe('cancelled');
  });

  it('defaults to 5,000 events', () => {
    expect(DEFAULT_MAX_EVENTS_PER_MISSION).toBe(5000);
  });
});

describe('idempotent create', () => {
  it('replays the first state even after the mission changed', () => {
    const h = createHarness();
    const ctx = h.ctx(h.owner, { idempotencyKey: 'create-me' });
    const created = h.core.missions.createMission(
      ctx,
      mission({ title: 'Original' }),
    );
    h.core.missions.updateMission(h.ctx(), created.mission.id, 1, {
      title: 'Changed',
    });
    h.core.missions.transitionMission(
      h.ctx(),
      created.mission.id,
      2,
      'planning',
      null,
    );

    const repeat = h.core.missions.createMission(
      ctx,
      mission({ title: 'Original' }),
    );

    expect(repeat.replayed).toBe(true);
    expect(repeat.mission).toMatchObject({
      version: 1,
      state: 'draft',
      title: 'Original',
    });
  });

  it('derives full-length ids, and an explicit correlation id wins over the key', () => {
    const h = createHarness();
    const withBoth = h.core.missions.createMission(
      h.ctx(h.owner, {
        idempotencyKey: 'key-1',
        correlationId: 'corr-explicit',
      }),
      mission(),
    );
    const keyOnly = h.core.missions.createMission(
      h.ctx(h.owner, { idempotencyKey: 'key-2' }),
      mission(),
    );

    expect(withBoth.mission.id).toMatch(/^msn_[0-9a-f]{32}$/);
    expect(withBoth.mission.id).not.toBe(keyOnly.mission.id);
    expect(withBoth.event.correlationId).toBe('corr-explicit');
    expect(keyOnly.event.correlationId).toBe('key-2');

    const packet = h.core.missions.addPacket(
      h.ctx(h.owner, { idempotencyKey: 'pkt-9' }),
      keyOnly.mission.id,
      1,
      {
        title: 'a',
        instructions: '',
        scope: [],
        required: true,
        dependsOn: [],
      },
    );
    expect(packet.mission.packets[0]?.id).toMatch(/^pkt_[0-9a-f]{32}$/);
  });
});

describe('where the work breakdown may change', () => {
  const PATHS: Record<string, string[]> = {
    draft: [],
    planning: ['planning'],
    ready: ['ready'],
    running: ['ready', 'running'],
    'waiting-runner': ['ready', 'waiting-runner'],
    'waiting-decision': ['ready', 'waiting-decision'],
    'waiting-external': ['ready', 'waiting-external'],
    'needs-attention': ['ready', 'needs-attention'],
  };

  function withTwoPackets(h: Harness) {
    const m = MissionDriver.create(h);
    // Optional packets, so the mission can still complete in the states that need it.
    const a = m.addPacket('a', { required: false });
    const b = m.addPacket('b', { required: false });
    return { m, a, b };
  }

  it.each(Object.keys(PATHS))(
    'accepts packets, dependencies and authorization in %s',
    (state) => {
      const h = createHarness();
      const { m, a, b } = withTwoPackets(h);
      for (const step of PATHS[state] ?? []) {
        m.go(step as MissionStatus);
      }
      expect(() => m.addPacket('c')).not.toThrow();
      expect(() =>
        h.core.missions.addDependency(h.ctx(), m.id, m.refresh().version, b, a),
      ).not.toThrow();
      expect(() => m.authorize(m.refresh().packets[0]?.id ?? a)).not.toThrow();
    },
  );

  it.each(['verifying', 'reconciling', 'completed', 'cancelled'])(
    'refuses packets, dependencies and authorization in %s, appending nothing',
    (state) => {
      const h = createHarness();
      const { m, a, b } = withTwoPackets(h);
      m.go('ready');
      if (state === 'cancelled') {
        m.go('cancelled');
      } else {
        m.go('verifying');
        if (state !== 'verifying') {
          if (state === 'completed') {
            m.verifyOutcome();
            m.go('completed');
          } else {
            m.go('reconciling');
          }
        }
      }
      expect(m.refresh().state).toBe(state);
      const before = stored(h, m.id).length;

      expect(() => m.addPacket('late')).toThrow(CommandNotAllowedError);
      expect(() =>
        h.core.missions.addDependency(h.ctx(), m.id, m.state.version, b, a),
      ).toThrow(CommandNotAllowedError);
      expect(() => m.authorize(a)).toThrow(CommandNotAllowedError);
      expect(stored(h, m.id)).toHaveLength(before);
    },
  );

  it('rejects a dependency on a packet that does not exist', () => {
    const h = createHarness();
    const { m, a } = withTwoPackets(h);
    const before = stored(h, m.id).length;

    expect(() =>
      h.core.missions.addDependency(
        h.ctx(),
        m.id,
        m.state.version,
        a,
        'pkt_ghost',
      ),
    ).toThrow(PacketNotFoundError);

    expect(stored(h, m.id)).toHaveLength(before);
    expect(m.refresh().packets[0]?.dependsOn).toEqual([]);
  });
});

describe('required children by state', () => {
  const PATHS: Record<string, string[]> = {
    draft: [],
    planning: ['planning'],
    ready: ['ready'],
    running: ['ready', 'running'],
    'waiting-runner': ['ready', 'waiting-runner'],
    'waiting-decision': ['ready', 'waiting-decision'],
    'waiting-external': ['ready', 'waiting-external'],
    verifying: ['ready', 'verifying'],
    reconciling: ['ready', 'verifying', 'reconciling'],
    'needs-attention': ['ready', 'needs-attention'],
  };

  it.each(Object.keys(PATHS))(
    'blocks the parent while a required child is %s',
    (state) => {
      const h = createHarness();
      const parent = MissionDriver.create(h);
      const child = MissionDriver.create(h, mission({ parentId: parent.id }));
      for (const step of PATHS[state] ?? []) {
        child.go(step as MissionStatus);
      }
      parent.toVerifying();
      parent.verifyOutcome();

      try {
        parent.go('completed');
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(CompletionGuardFailedError);
        expect((error as CompletionGuardFailedError).failures).toEqual([
          {
            guard: 'required-children-completed',
            reason: expect.stringContaining(child.id),
          },
        ]);
      }
    },
  );
});

describe('attempts and cancellation', () => {
  it('records the active attempt on dispatch and clears it on a report', () => {
    const h = createHarness();
    const { m, a } = dispatched(h);
    const attemptId = m.refresh().attempts[0]?.id;
    expect(m.state.packets[0]?.activeAttemptId).toBe(attemptId);

    m.runAttempt(a, 'failed');
    expect(m.state.packets[0]).toMatchObject({
      status: 'failed',
      activeAttemptId: null,
    });
  });

  it('cancels leased and running attempts and keeps reported ones', () => {
    const h = createHarness();
    h.pool.online = ['prn_runner'];
    const m = MissionDriver.create(h);
    m.go('ready');
    const ids = ['a', 'b', 'c'].map((t) => m.addPacket(t));
    for (const id of ids) {
      m.authorize(id);
    }
    m.tick();
    const [a, b] = ids as [string, string];
    const attemptOf = (packetId: string) =>
      m.refresh().packets.find((p) => p.id === packetId)?.activeAttemptId ?? '';
    const runnerCtx = h.ctx(h.runner);
    m.state = h.core.missions.startAttempt(
      runnerCtx,
      m.id,
      m.state.version,
      attemptOf(b),
    ).mission;
    m.runAttempt(a);

    const cancelled = h.core.missions.cancelMission(
      h.ctx(),
      m.id,
      m.state.version,
      null,
    ).mission;

    expect(cancelled.attempts.map((x) => [x.packetId, x.status])).toEqual([
      [a, 'self-reported-succeeded'],
      [b, 'cancelled'],
      [ids[2], 'cancelled'],
    ]);
    expect(
      cancelled.packets.every(
        (p) => p.status === 'cancelled' && p.activeAttemptId === null,
      ),
    ).toBe(true);
  });

  it('refuses a provider adapter on start and report', () => {
    const h = createHarness();
    const { m } = dispatched(h);
    const adapter = seedFixedPrincipal(h.db, 'prn_adapter', 'provider_adapter');
    const attemptId = m.refresh().attempts[0]?.id ?? '';
    expect(() =>
      h.core.missions.startAttempt(
        h.ctx(adapter),
        m.id,
        m.state.version,
        attemptId,
      ),
    ).toThrow(ForbiddenActorError);
    expect(() =>
      h.core.missions.reportAttempt(
        h.ctx(adapter),
        m.id,
        m.state.version,
        attemptId,
        'succeeded',
        null,
      ),
    ).toThrow(ForbiddenActorError);
  });

  it('only blocks a producer from verifying the packet they reported', () => {
    const h = createHarness();
    h.pool.online = ['prn_runner'];
    const m = MissionDriver.create(h);
    m.go('ready');
    const a = m.addPacket('a');
    const b = m.addPacket('b');
    m.authorize(a);
    m.authorize(b);
    m.tick();
    const attemptOf = (packetId: string) =>
      m.refresh().packets.find((p) => p.id === packetId)?.activeAttemptId ?? '';
    // The owner reports packet a on a runner's behalf. The runner reports packet b.
    m.state = h.core.missions.reportAttempt(
      h.ctx(h.owner),
      m.id,
      m.state.version,
      attemptOf(a),
      'succeeded',
      null,
    ).mission;
    m.runAttempt(b);

    expect(
      m.verifyPacket(b, h.owner).packets.find((p) => p.id === b)?.status,
    ).toBe('verified');
    expect(() => m.verifyPacket(a, h.owner)).toThrow(SelfVerificationError);
  });
});

describe('evidence and updates', () => {
  it('records each evidence ref once, in first-seen order', () => {
    const h = createHarness();
    const { m, a } = dispatched(h);
    m.runAttempt(a);
    h.core.missions.verifyPacket(h.ctx(), m.id, m.state.version, a, [
      'dup',
      'dup',
      'other',
    ]);
    m.refresh();
    m.tick();
    h.core.missions.verifyOutcome(h.ctx(), m.id, m.state.version, [
      'dup',
      'last',
    ]);

    expect(m.refresh().evidenceRefs).toEqual(['dup', 'other', 'last']);
  });

  it('refuses an update that names fields outside the changeable set', () => {
    const h = createHarness();
    const m = MissionDriver.create(h);
    const before = stored(h, m.id).length;

    expect(() =>
      h.core.missions.updateMission(h.ctx(), m.id, 1, {
        state: 'completed',
        id: 'x',
        packets: [],
      } as never),
    ).toThrow(ValidationError);

    expect(stored(h, m.id)).toHaveLength(before);
    expect(h.core.missions.getMission(WS, m.id)).toMatchObject({
      state: 'draft',
      id: m.id,
    });
  });

  it('checks every checklist item for done:true on creation', () => {
    expect(() =>
      parseCreateMission({
        title: 'T',
        intent: 'I',
        outcome: 'O',
        definitionOfDone: [
          { text: 'a', done: false },
          { text: 'b', done: true },
        ],
      }),
    ).toThrow(/definitionOfDone\[1\]\.done/);
  });
});

describe('scheduler requests', () => {
  it('asks the pool about the ready packet in the right workspace and labels its events', () => {
    const h = createHarness();
    h.pool.online = ['prn_runner'];
    const m = MissionDriver.create(h);
    m.go('ready');
    const a = m.addPacket('a');
    m.authorize(a);

    const result = h.core.scheduler.tick(WS, h.owner, 'corr-tick');
    m.refresh();

    expect(h.pool.requests).toHaveLength(1);
    // The request is a snapshot from the moment of the call, before the dispatch it led to.
    expect(h.pool.requests[0]).toMatchObject({
      workspaceId: WS,
      mission: { id: m.id, state: 'ready', attempts: [] },
      packet: { id: a, status: 'ready' },
    });
    const tickEvents = stored(h, m.id).slice(-3);
    expect(tickEvents.map((e) => [e.type, e.correlationId])).toEqual([
      ['packet.readied', 'corr-tick'],
      ['attempt.dispatched', 'corr-tick'],
      ['mission.transitioned', 'corr-tick'],
    ]);
    expect(tickEvents[2]?.payload).toMatchObject({
      to: 'running',
      reason: 'scheduler',
    });
    expect(result.changes[0]?.events).toEqual(tickEvents.map((e) => e.type));
  });
});

describe('deriveMissionState splits', () => {
  type P = Partial<MissionState['packets'][number]> & { id: string };
  const mk = (...packets: P[]): MissionState =>
    ({
      packets: packets.map((p) => ({
        status: 'pending',
        required: true,
        dependsOn: [],
        authorization: null,
        ...p,
      })),
    }) as unknown as MissionState;
  const auth = { at: 't', by: 'x', policyRefs: [] };

  it('does not verify a mission whose live packets are all optional and unverified', () => {
    expect(
      deriveMissionState(mk({ id: 'a', required: false, authorization: auth })),
    ).toBe('needs-attention');
  });

  it('verifies when only optional packets are left unverified after the required ones', () => {
    expect(
      deriveMissionState(
        mk({ id: 'a', status: 'verified' }, { id: 'b', required: false }),
      ),
    ).toBe('verifying');
  });

  it('waits for a decision only for an unauthorized packet whose prerequisites are verified', () => {
    expect(deriveMissionState(mk({ id: 'a' }))).toBe('waiting-decision');
    expect(
      deriveMissionState(
        mk({ id: 'a', status: 'verified' }, { id: 'b', dependsOn: ['a'] }),
      ),
    ).toBe('waiting-decision');
    expect(
      deriveMissionState(
        mk({ id: 'a', status: 'failed' }, { id: 'b', dependsOn: ['a'] }),
      ),
    ).toBe('needs-attention');
  });

  it('asks for attention, not a decision, for an authorized packet blocked behind a failure', () => {
    expect(
      deriveMissionState(
        mk(
          { id: 'a', status: 'failed' },
          { id: 'b', dependsOn: ['a'], authorization: auth },
        ),
      ),
    ).toBe('needs-attention');
  });

  it('builds a core with the default cap when none is given', () => {
    const h = createHarness();
    expect(createCore({ db: h.db })).toBeDefined();
  });
});

describe('state changes that must not slip through', () => {
  it('ignores fields outside the changeable set when applying a recorded update event', () => {
    const h = createHarness();
    const m = MissionDriver.create(h);
    const created = stored(h, m.id)[0];
    if (created === undefined) {
      throw new Error('no created event');
    }
    const hostile = {
      ...created,
      version: 2,
      type: 'mission.updated',
      payload: {
        changes: { title: 'ok', state: 'completed', id: 'zzz', packets: [{}] },
      },
    };

    const next = applyEvent(m.state, hostile);

    expect(next).toMatchObject({ title: 'ok', state: 'draft', id: m.id });
    expect(next.packets).toEqual([]);
  });

  it('does not record a scheduler decision that fails its check, even if the caller catches the error', () => {
    const h = createHarness();
    const m = MissionDriver.create(h);
    m.go('ready');
    const before = stored(h, m.id).length;

    const outcome = h.core.missions.withMission(
      WS,
      m.id,
      h.owner,
      (session) => {
        try {
          session.step(readyPacketDecision('pkt_missing'), {
            correlationId: 'c',
            at: 't',
          });
          return 'accepted';
        } catch (error) {
          return error instanceof PacketNotFoundError ? 'refused' : 'other';
        }
      },
    );

    expect(outcome).toBe('refused');
    expect(stored(h, m.id)).toHaveLength(before);
    expect(h.core.missions.replayMission(WS, m.id)).toEqual(
      h.core.missions.getMission(WS, m.id),
    );
  });
});

describe('the event cap and the scheduler', () => {
  it('flags a failed mission for attention even at the cap', () => {
    const h = createHarness({ maxEventsPerMission: 9 });
    h.pool.online = ['prn_runner'];
    const m = MissionDriver.create(h);
    m.go('ready');
    const a = m.addPacket('a');
    m.authorize(a);
    m.tick();
    m.runAttempt(a, 'failed');
    expect(stored(h, m.id)).toHaveLength(9);
    expect(m.state.state).toBe('running');

    const result = m.tick();

    expect(result.changes).toEqual([
      expect.objectContaining({
        to: 'needs-attention',
        events: ['mission.transitioned'],
      }),
    ]);
    expect(m.refresh().state).toBe('needs-attention');
  });

  it('never appends past the cap in one tick', () => {
    const h = createHarness({ maxEventsPerMission: 8 });
    h.pool.online = ['prn_runner'];
    const m = MissionDriver.create(h);
    m.go('ready');
    const ids = ['a', 'b', 'c'].map((t) => m.addPacket(t));
    m.authorize(ids[0] ?? '');
    m.authorize(ids[1] ?? '');
    expect(stored(h, m.id)).toHaveLength(7);

    m.tick();

    expect(stored(h, m.id)).toHaveLength(8);
    expect(m.state.packets.map((p) => p.status)).toEqual([
      'ready',
      'pending',
      'pending',
    ]);
  });

  it('lets a runner finish an attempt that was dispatched at the cap, but nothing else', () => {
    const h = createHarness({ maxEventsPerMission: 6 });
    h.pool.online = ['prn_runner'];
    const m = MissionDriver.create(h);
    m.go('ready');
    const a = m.addPacket('a');
    m.authorize(a);
    m.tick();
    expect(stored(h, m.id)).toHaveLength(6);
    expect(m.state.packets[0]?.status).toBe('leased');

    m.runAttempt(a);

    expect(m.state.packets[0]?.status).toBe('reported');
    expect(stored(h, m.id)).toHaveLength(8);
    expect(() => m.verifyPacket(a)).toThrow(CommandNotAllowedError);
  });

  it('refuses completion and new work at the cap', () => {
    const h = createHarness({ maxEventsPerMission: 4 });
    const m = MissionDriver.create(h);
    m.go('ready');
    m.go('verifying');
    m.verifyOutcome();
    expect(stored(h, m.id)).toHaveLength(4);

    expect(() => m.go('completed')).toThrow(CommandNotAllowedError);
    expect(() => m.go('reconciling')).toThrow(CommandNotAllowedError);
    expect(() =>
      h.core.missions.updateMission(h.ctx(), m.id, 4, { title: 'x' }),
    ).toThrow(CommandNotAllowedError);
    expect(stored(h, m.id)).toHaveLength(4);
  });
});

describe('updates', () => {
  const VALUES = {
    title: 'New title',
    intent: 'New intent',
    outcome: 'New outcome',
    constraints: ['new constraint'],
    risk: 'high',
    size: 'xl',
    priority: 'urgent',
    definitionOfDone: [{ text: 'new item', done: false }],
    links: [
      {
        url: 'https://example.com/new',
        classification: 'optional',
        title: null,
      },
    ],
    policyRefs: ['policy:new'],
  } as const;

  it.each(Object.keys(VALUES))('changes %s and survives replay', (key) => {
    const h = createHarness();
    const m = MissionDriver.create(h);
    const changes = { [key]: VALUES[key as keyof typeof VALUES] };

    const updated = h.core.missions.updateMission(
      h.ctx(),
      m.id,
      1,
      changes as never,
    );

    expect(updated.mission[key as keyof MissionState]).toEqual(
      VALUES[key as keyof typeof VALUES],
    );
    expect(h.core.missions.replayMission(WS, m.id)).toEqual(updated.mission);
  });

  it('covers every changeable field in this table', () => {
    expect(Object.keys(VALUES).sort()).toEqual([...MISSION_CHANGE_KEYS].sort());
  });

  it('refuses an update that changes nothing and keeps a verified outcome intact', () => {
    const h = createHarness();
    const m = MissionDriver.create(h);
    m.toVerifying();
    m.verifyOutcome();
    const before = stored(h, m.id).length;

    for (const changes of [{}, { title: undefined }]) {
      expect(() =>
        h.core.missions.updateMission(
          h.ctx(),
          m.id,
          m.state.version,
          changes as never,
        ),
      ).toThrow(/at least one field/);
    }

    expect(stored(h, m.id)).toHaveLength(before);
    expect(m.refresh().outcomeVerification).not.toBeNull();
  });
});

describe('direct scheduler steps and recorded no-op updates', () => {
  it('refuses a non-exempt step on a full stream even when called directly', () => {
    const h = createHarness({ maxEventsPerMission: 3 });
    const m = MissionDriver.create(h);
    m.go('ready');
    const a = m.addPacket('a');
    expect(stored(h, m.id)).toHaveLength(3);

    const outcome = h.core.missions.withMission(
      WS,
      m.id,
      h.owner,
      (session) => {
        try {
          session.step(readyPacketDecision(a), { correlationId: 'c', at: 't' });
          return 'accepted';
        } catch (error) {
          return error instanceof CommandNotAllowedError ? 'refused' : 'other';
        }
      },
    );

    expect(outcome).toBe('refused');
    expect(stored(h, m.id)).toHaveLength(3);
  });

  it('keeps a verified outcome when a recorded update event carries no changes', () => {
    const h = createHarness();
    const m = MissionDriver.create(h);
    m.toVerifying();
    m.verifyOutcome();
    const last = stored(h, m.id).at(-1);
    if (last === undefined) {
      throw new Error('no events');
    }

    const next = applyEvent(m.state, {
      ...last,
      version: m.state.version + 1,
      type: 'mission.updated',
      payload: { changes: {} },
    });

    expect(next.outcomeVerification).not.toBeNull();
  });
});
