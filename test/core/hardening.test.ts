import { describe, expect, it } from 'vitest';
import {
  CommandNotAllowedError,
  CompletionGuardFailedError,
  ForbiddenActorError,
  InvalidTransitionError,
  ValidationError,
} from '../../src/core/errors.js';
import { outcomeVerifiedGuard } from '../../src/core/guards.js';
import { parseCreateMission } from '../../src/core/inputs.js';
import { applyEvent, replay } from '../../src/core/reducer.js';
import type { MissionState } from '../../src/core/types.js';
import { VersionConflictError } from '../../src/events/errors.js';
import { createEventLog } from '../../src/events/event-log.js';
import { TEST_WORKSPACE } from '../helpers/tower.js';
import {
  createHarness,
  type Harness,
  MissionDriver,
  mission,
  seedFixedPrincipal,
} from './helpers.js';

function failedGuards(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof CompletionGuardFailedError) {
      return error.failures.map((f) => f.guard);
    }
    throw error;
  }
  throw new Error('expected the completion to be refused');
}

function dispatched(h: Harness) {
  h.pool.online = ['prn_runner'];
  const m = MissionDriver.create(h);
  m.go('ready');
  const a = m.addPacket('A');
  m.authorize(a);
  m.tick();
  return { m, a };
}

describe('principal kinds are enforced in the core, not only by token scopes', () => {
  it('refuses a runner on every mutating command', () => {
    const h = createHarness();
    const { m, a } = dispatched(h);
    m.runAttempt(a);
    m.refresh();
    const run = (fn: (v: number) => unknown) => () => fn(m.state.version);
    const { missions } = h.core;
    const ctx = h.ctx(h.runner);
    const calls: Record<string, () => unknown> = {
      update: run((v) => missions.updateMission(ctx, m.id, v, { title: 'x' })),
      transition: run((v) =>
        missions.transitionMission(ctx, m.id, v, 'verifying', null),
      ),
      cancel: run((v) => missions.cancelMission(ctx, m.id, v, null)),
      verifyOutcome: run((v) => missions.verifyOutcome(ctx, m.id, v, ['ev'])),
      addPacket: run((v) =>
        missions.addPacket(ctx, m.id, v, {
          title: 'x',
          instructions: '',
          scope: [],
          required: true,
          dependsOn: [],
        }),
      ),
      addDependency: run((v) => missions.addDependency(ctx, m.id, v, a, a)),
      authorize: run((v) => missions.authorizePacket(ctx, m.id, v, a, [])),
      verifyPacket: run((v) => missions.verifyPacket(ctx, m.id, v, a, ['ev'])),
      rejectPacket: run((v) => missions.rejectPacket(ctx, m.id, v, a, null)),
      requeue: run((v) => missions.requeuePacket(ctx, m.id, v, a)),
    };
    for (const [name, call] of Object.entries(calls)) {
      expect(call, name).toThrow(ForbiddenActorError);
    }
    expect(h.core.missions.getMission(TEST_WORKSPACE, m.id)?.version).toBe(
      m.state.version,
    );
  });

  it('refuses a provider adapter the same way', () => {
    const h = createHarness();
    const adapter = seedFixedPrincipal(h.db, 'prn_adapter', 'provider_adapter');
    const m = MissionDriver.create(h);
    expect(() =>
      h.core.missions.updateMission(h.ctx(adapter), m.id, 1, { title: 'x' }),
    ).toThrow(ForbiddenActorError);
  });

  it('lets a runner act only on its own attempt', () => {
    const h = createHarness();
    const { m, a } = dispatched(h);
    const other = seedFixedPrincipal(h.db, 'prn_runner2', 'runner');
    const attemptId = m.refresh().packets[0]?.activeAttemptId ?? '';

    expect(() =>
      h.core.missions.startAttempt(
        h.ctx(other),
        m.id,
        m.state.version,
        attemptId,
      ),
    ).toThrow(ForbiddenActorError);
    expect(() =>
      h.core.missions.reportAttempt(
        h.ctx(other),
        m.id,
        m.state.version,
        attemptId,
        'succeeded',
        null,
      ),
    ).toThrow(ForbiddenActorError);
    expect(m.refresh().packets[0]?.status).toBe('leased');

    m.runAttempt(a);
    expect(m.state.packets[0]?.status).toBe('reported');
  });
});

describe('who may do what to a mission in which state', () => {
  it('refuses to update a completed mission', () => {
    const h = createHarness();
    const m = MissionDriver.create(h);
    m.toVerifying();
    m.verifyOutcome();
    m.go('completed');
    expect(() =>
      h.core.missions.updateMission(h.ctx(), m.id, m.state.version, {
        title: 'x',
      }),
    ).toThrow(CommandNotAllowedError);
  });

  it('authorizes a packet only once', () => {
    const h = createHarness();
    const m = MissionDriver.create(h);
    const a = m.addPacket('A');
    m.authorize(a);
    expect(() => m.authorize(a)).toThrow(/already authorized/);
  });

  it('refuses authorization and new dependencies once the mission is verifying', () => {
    const h = createHarness();
    const m = MissionDriver.create(h);
    const a = m.addPacket('A');
    const b = m.addPacket('B');
    m.go('ready');
    m.go('verifying');
    expect(() => m.authorize(a)).toThrow(CommandNotAllowedError);
    expect(() =>
      h.core.missions.addDependency(h.ctx(), m.id, m.state.version, b, a),
    ).toThrow(CommandNotAllowedError);
  });

  it('caps the packets in a mission', () => {
    const h = createHarness();
    const m = MissionDriver.create(h);
    for (let i = 0; i < 200; i += 1) {
      m.addPacket(`p${i}`);
    }
    expect(() => m.addPacket('one too many')).toThrow(/at most 200/);
  });

  it('rejects a stale expected version on every command, appending nothing', () => {
    const h = createHarness();
    const m = MissionDriver.create(h);
    const a = m.addPacket('A');
    const stale = m.state.version - 1;
    const { missions } = h.core;
    const ctx = h.ctx();
    const calls = [
      () => missions.transitionMission(ctx, m.id, stale, 'ready', null),
      () => missions.cancelMission(ctx, m.id, stale, null),
      () =>
        missions.addPacket(ctx, m.id, stale, {
          title: 'x',
          instructions: '',
          scope: [],
          required: true,
          dependsOn: [],
        }),
      () => missions.authorizePacket(ctx, m.id, stale, a, []),
      () => missions.verifyOutcome(ctx, m.id, stale, ['ev']),
    ];
    const before = createEventLog(h.db).readStream(
      TEST_WORKSPACE,
      `mission:${m.id}`,
    ).length;
    for (const call of calls) {
      expect(call).toThrow(VersionConflictError);
    }
    expect(
      createEventLog(h.db).readStream(TEST_WORKSPACE, `mission:${m.id}`),
    ).toHaveLength(before);
  });

  it('requires evidence to verify a packet or an outcome', () => {
    const h = createHarness();
    const { m, a } = dispatched(h);
    m.runAttempt(a);
    expect(() =>
      h.core.missions.verifyPacket(h.ctx(), m.id, m.state.version, a, []),
    ).toThrow(ValidationError);
    m.verifyPacket(a);
    m.tick();
    expect(m.state.state).toBe('verifying');
    expect(() =>
      h.core.missions.verifyOutcome(h.ctx(), m.id, m.state.version, []),
    ).toThrow(ValidationError);
  });

  it('rejects a reported packet, marks it failed, and refuses to reject anything else', () => {
    const h = createHarness();
    const { m, a } = dispatched(h);
    expect(() =>
      h.core.missions.rejectPacket(h.ctx(), m.id, m.state.version, a, null),
    ).toThrow(CommandNotAllowedError);
    m.runAttempt(a);

    const rejected = h.core.missions.rejectPacket(
      h.ctx(),
      m.id,
      m.state.version,
      a,
      'tests missing',
    );

    m.state = rejected.mission;
    expect(rejected.mission.packets[0]).toMatchObject({
      status: 'failed',
      verification: null,
    });
    expect(rejected.event.payload).toEqual({
      packetId: a,
      reason: 'tests missing',
    });
    expect(() => m.verifyPacket(a)).toThrow(InvalidTransitionError);
  });
});

describe('requeue and re-completion need fresh decisions', () => {
  it('clears the authorization of a requeued packet, so it cannot run again unapproved', () => {
    const h = createHarness();
    const { m, a } = dispatched(h);
    m.runAttempt(a, 'failed');

    m.state = h.core.missions.requeuePacket(
      h.ctx(),
      m.id,
      m.state.version,
      a,
    ).mission;
    expect(m.state.packets[0]).toMatchObject({
      status: 'pending',
      authorization: null,
    });

    m.go('ready');
    m.tick();
    expect(m.state.state).toBe('waiting-decision');
    expect(m.state.attempts).toHaveLength(1);

    m.authorize(a);
    m.tick();
    expect(m.state.attempts.map((x) => x.number)).toEqual([1, 2]);
  });

  it('discards the verdict and completion time when a completed mission is reopened', () => {
    const h = createHarness();
    const m = MissionDriver.create(h);
    m.toVerifying();
    m.verifyOutcome();
    m.go('completed');
    expect(m.state.completedAt).not.toBeNull();

    m.go('reconciling');
    expect(m.state).toMatchObject({
      completedAt: null,
      outcomeVerification: null,
    });
    m.go('verifying');
    expect(failedGuards(() => m.go('completed'))).toEqual(['outcome-verified']);
    m.verifyOutcome();
    expect(m.go('completed').state).toBe('completed');
  });

  it('does the same when the reopening goes through needs-attention', () => {
    const h = createHarness();
    const m = MissionDriver.create(h);
    m.toVerifying();
    m.verifyOutcome();
    m.go('completed');
    m.go('needs-attention');
    m.go('verifying');
    expect(failedGuards(() => m.go('completed'))).toEqual(['outcome-verified']);
  });
});

describe('guard details', () => {
  it('ignores an unverified optional packet when completing', () => {
    const h = createHarness();
    const m = MissionDriver.create(h);
    m.go('ready');
    const a = m.addPacket('required');
    m.addPacket('optional', { required: false });
    m.authorize(a);
    h.pool.online = ['prn_runner'];
    m.tick();
    m.runAttempt(a);
    m.verifyPacket(a);
    m.tick();
    m.verifyOutcome();

    expect(m.go('completed').state).toBe('completed');
  });

  it('refuses outcome evidence that carries no references', () => {
    const base = {
      outcomeVerification: { at: 't', by: 'x', evidenceRefs: [] },
    } as unknown as MissionState;
    expect(
      outcomeVerifiedGuard.check({ mission: base, children: [] }),
    ).toMatchObject({ ok: false });
    const ok = {
      outcomeVerification: { at: 't', by: 'x', evidenceRefs: ['e'] },
    } as unknown as MissionState;
    expect(outcomeVerifiedGuard.check({ mission: ok, children: [] })).toEqual({
      ok: true,
    });
  });

  it('keeps a packet with two prerequisites pending until both are verified', () => {
    const h = createHarness();
    h.pool.online = ['prn_runner'];
    const m = MissionDriver.create(h);
    m.go('ready');
    const a = m.addPacket('a');
    const b = m.addPacket('b');
    const c = m.addPacket('c', { dependsOn: [a, b] });
    for (const id of [a, b, c]) {
      m.authorize(id);
    }
    m.tick();
    m.runAttempt(a);
    m.verifyPacket(a);
    m.tick();
    expect(m.state.packets.find((p) => p.id === c)?.status).toBe('pending');

    m.runAttempt(b);
    m.verifyPacket(b);
    m.tick();
    expect(m.state.packets.find((p) => p.id === c)?.status).toBe('leased');
  });
});

describe('definition of done', () => {
  it('cannot be created already done', () => {
    expect(() =>
      parseCreateMission({
        title: 'T',
        intent: 'I',
        outcome: 'O',
        definitionOfDone: [{ text: 'x', done: true }],
      }),
    ).toThrow(/must be false on creation/);
  });

  it('is ticked off by an update, which also discards any earlier verdict', () => {
    const h = createHarness();
    const m = MissionDriver.create(
      h,
      mission({ definitionOfDone: [{ text: 'docs', done: false }] }),
    );
    m.toVerifying();
    expect(failedGuards(() => m.go('completed'))).toContain(
      'definition-of-done',
    );
    m.state = h.core.missions.updateMission(h.ctx(), m.id, m.state.version, {
      definitionOfDone: [{ text: 'docs', done: true }],
    }).mission;
    m.verifyOutcome();
    expect(m.go('completed').state).toBe('completed');
  });
});

describe('refs are recorded on events and state', () => {
  it('keeps policy and evidence refs on the events, packets and mission', () => {
    const h = createHarness();
    h.pool.online = ['prn_runner'];
    const m = MissionDriver.create(h, mission({ policyRefs: ['policy:v1'] }));
    m.go('ready');
    const a = m.addPacket('A');
    m.authorize(a, h.cos, ['policy:v2']);
    m.tick();
    m.runAttempt(a);
    m.verifyPacket(a);
    m.tick();
    m.verifyOutcome();
    m.go('completed');

    const items = h.core.missions.activity(TEST_WORKSPACE, m.id, {
      afterVersion: 0,
      limit: 100,
    }).items;
    const of = (type: string) => items.find((i) => i.type === type);
    expect(of('mission.created')).toMatchObject({
      policyRefs: ['policy:v1'],
      correlationId: expect.any(String),
    });
    expect(of('packet.authorized')).toMatchObject({
      policyRefs: ['policy:v2'],
      actorId: 'prn_cos',
    });
    expect(of('packet.verified')?.evidenceRefs).toEqual(['ev:packet']);
    expect(of('mission.outcome_verified')?.evidenceRefs).toEqual([
      'ev:outcome',
    ]);
    expect(m.state).toMatchObject({
      evidenceRefs: ['ev:packet', 'ev:outcome'],
      outcomeVerification: { evidenceRefs: ['ev:outcome'] },
    });
    expect(m.state.packets[0]).toMatchObject({
      authorization: { by: 'prn_cos', policyRefs: ['policy:v2'] },
      verification: { evidenceRefs: ['ev:packet'] },
    });
  });
});

describe('replay depends on the events alone', () => {
  it('rebuilds a rich history from events with the projection destroyed', () => {
    const h = createHarness();
    h.pool.online = ['prn_runner'];
    const m = MissionDriver.create(h);
    m.go('ready');
    const a = m.addPacket('a');
    const b = m.addPacket('b');
    const c = m.addPacket('c');
    m.state = h.core.missions.addDependency(
      h.ctx(),
      m.id,
      m.state.version,
      c,
      a,
    ).mission;
    for (const id of [a, b, c]) {
      m.authorize(id);
    }
    m.tick();
    m.runAttempt(a, 'failed');
    m.state = h.core.missions.requeuePacket(
      h.ctx(),
      m.id,
      m.state.version,
      a,
    ).mission;
    m.authorize(a);
    m.tick();
    m.runAttempt(a);
    m.state = h.core.missions.rejectPacket(
      h.ctx(),
      m.id,
      m.state.version,
      a,
      'again',
    ).mission;
    m.runAttempt(b);
    m.verifyPacket(b);
    m.state = h.core.missions.cancelMission(
      h.ctx(),
      m.id,
      m.state.version,
      'stop',
    ).mission;
    const expected = structuredClone(m.state);

    h.db.run("UPDATE missions SET snapshot_json = '{}'");
    const replayed = h.core.missions.replayMission(TEST_WORKSPACE, m.id);

    expect(replayed).toEqual(expected);
    expect(replayed.packets.map((p) => [p.title, p.status])).toEqual([
      ['a', 'cancelled'],
      ['b', 'verified'],
      ['c', 'cancelled'],
    ]);
    expect(
      replayed.attempts
        .filter((x) => x.packetId === a)
        .map((x) => [x.number, x.status]),
    ).toEqual([
      [1, 'self-reported-failed'],
      [2, 'self-reported-succeeded'],
    ]);
    expect(replayed.packets[2]?.dependsOn).toEqual([a]);
    expect(replayed.cancelledAt).not.toBeNull();
  });

  it('does not modify the state it is given, and replay stops at the requested version', () => {
    const h = createHarness();
    const m = MissionDriver.create(h);
    m.go('planning');
    m.go('ready');
    const events = createEventLog(h.db).readStream(
      TEST_WORKSPACE,
      `mission:${m.id}`,
    );
    const first = replay(events, 1);
    const frozen = structuredClone(first);

    const next = applyEvent(first, events[1] as never);

    expect(first).toEqual(frozen);
    expect(next.state).toBe('planning');
    expect(replay(events, 2).state).toBe('planning');
    expect(replay(events).state).toBe('ready');
  });
});

describe('event cap', () => {
  it('stops accepting changes at the cap but still lets the mission be cancelled', () => {
    const h = createHarness({ maxEventsPerMission: 4 });
    const m = MissionDriver.create(h);
    m.go('planning');
    m.go('ready');
    h.core.missions.updateMission(h.ctx(), m.id, 3, { title: 'fourth event' });

    expect(() =>
      h.core.missions.updateMission(h.ctx(), m.id, 4, { title: 'fifth' }),
    ).toThrow(/limit of 4 events/);
    expect(() =>
      h.core.missions.transitionMission(h.ctx(), m.id, 4, 'running', null),
    ).toThrow(CommandNotAllowedError);
    expect(
      h.core.missions.cancelMission(h.ctx(), m.id, 4, null).mission.state,
    ).toBe('cancelled');
  });
});

describe('projection', () => {
  it('writes packet, dependency and attempt rows that match the state', () => {
    const h = createHarness();
    h.pool.online = ['prn_runner'];
    const m = MissionDriver.create(h);
    m.go('ready');
    const a = m.addPacket('a');
    const b = m.addPacket('b', { dependsOn: [a] });
    m.authorize(a);
    m.authorize(b);
    m.tick();

    expect(
      h.db.all(
        'SELECT id, position, status, required FROM work_packets ORDER BY position',
      ),
    ).toEqual([
      { id: a, position: 1, status: 'leased', required: 1 },
      { id: b, position: 2, status: 'pending', required: 1 },
    ]);
    expect(
      h.db.all(
        'SELECT packet_id, depends_on_packet_id FROM packet_dependencies',
      ),
    ).toEqual([{ packet_id: b, depends_on_packet_id: a }]);
    expect(
      h.db.all(
        'SELECT packet_id, number, runner_id, status FROM execution_attempts',
      ),
    ).toEqual([
      { packet_id: a, number: 1, runner_id: 'prn_runner', status: 'leased' },
    ]);
  });
});
