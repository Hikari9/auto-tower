import { describe, expect, it } from 'vitest';
import {
  CommandNotAllowedError,
  CompletionGuardFailedError,
  ForbiddenActorError,
  InvalidTransitionError,
  SelfVerificationError,
} from '../../src/core/errors.js';
import { MISSION_TRANSITIONS } from '../../src/core/transitions.js';
import { MISSION_STATUSES, type MissionStatus } from '../../src/core/types.js';
import {
  createHarness,
  type Harness,
  MissionDriver,
  mission,
} from './helpers.js';

function guardFailures(fn: () => unknown): string[] {
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

function complete(m: MissionDriver) {
  return m.go('completed');
}

/** Runs one packet through dispatch, the runner's success report and Tower's verification. */
function finishPacket(h: Harness, m: MissionDriver, packetId: string) {
  h.pool.online = ['prn_runner'];
  m.tick();
  m.runAttempt(packetId);
  return m.verifyPacket(packetId);
}

describe('the completed state', () => {
  it('appears in the transition table under verifying only', () => {
    const sources = MISSION_STATUSES.filter((from) =>
      MISSION_TRANSITIONS[from].includes('completed'),
    );
    expect(sources).toEqual(['verifying']);
  });

  it('cannot be reached from any other state through the service', () => {
    for (const from of MISSION_STATUSES.filter(
      (s) => s !== 'verifying' && s !== 'cancelled' && s !== 'completed',
    )) {
      const h = createHarness();
      const m = MissionDriver.create(h);
      reach(m, from);
      expect(m.state.state).toBe(from);
      expect(() => complete(m), from).toThrow(InvalidTransitionError);
    }
  });

  it('is refused from verifying until outcome evidence exists', () => {
    const h = createHarness();
    const m = MissionDriver.create(h);
    m.toVerifying();

    expect(guardFailures(() => complete(m))).toEqual(['outcome-verified']);

    m.verifyOutcome();
    expect(complete(m)).toMatchObject({ state: 'completed' });
    expect(m.state.completedAt).not.toBeNull();
  });

  it('needs a runner-side success report to be verified by Tower, not taken at its word', () => {
    const h = createHarness();
    const m = MissionDriver.create(h);
    m.go('ready');
    const a = m.addPacket('Build');
    m.authorize(a);
    h.pool.online = ['prn_runner'];
    m.tick();
    m.runAttempt(a);
    expect(m.state.packets[0]).toMatchObject({
      status: 'reported',
      verification: null,
    });
    expect(m.state.attempts[0]).toMatchObject({
      status: 'self-reported-succeeded',
      report: { outcome: 'succeeded', by: 'prn_runner' },
    });

    // The mission is still running: a self-report moves nothing toward `verifying`.
    m.tick();
    expect(m.state.state).toBe('running');
    m.go('verifying');
    m.verifyOutcome();
    expect(guardFailures(() => complete(m))).toEqual([
      'required-packets-verified',
    ]);
  });

  it('is not triggered by a verified packet alone: the outcome needs its own evidence', () => {
    const h = createHarness();
    const m = MissionDriver.create(h);
    m.go('ready');
    const a = m.addPacket('Build');
    m.authorize(a);
    finishPacket(h, m, a);
    m.tick();

    expect(m.state).toMatchObject({ state: 'verifying' });
    expect(m.state.packets[0]?.status).toBe('verified');
    expect(guardFailures(() => complete(m))).toEqual(['outcome-verified']);
  });

  it('reports every failing guard at once', () => {
    const h = createHarness();
    const m = MissionDriver.create(
      h,
      mission({ definitionOfDone: [{ text: 'docs', done: false }] }),
    );
    m.go('ready');
    m.addPacket('Build');
    m.go('verifying');

    expect(guardFailures(() => complete(m)).sort()).toEqual([
      'definition-of-done',
      'outcome-verified',
      'required-packets-verified',
    ]);
  });

  it('leaves the mission untouched when refused', () => {
    const h = createHarness();
    const m = MissionDriver.create(h);
    m.toVerifying();
    const version = m.state.version;

    expect(() => complete(m)).toThrow(CompletionGuardFailedError);

    expect(h.core.missions.getMission('ws_test', m.id)).toMatchObject({
      version,
      state: 'verifying',
    });
  });

  it('is refused for a runner principal even holding the evidence', () => {
    const h = createHarness();
    const m = MissionDriver.create(h);
    m.toVerifying();
    m.verifyOutcome();
    expect(() => m.go('completed', h.runner)).toThrow(ForbiddenActorError);
  });

  it('drops the verdict when the mission is edited or sent back for rework', () => {
    const h = createHarness();
    const m = MissionDriver.create(h);
    m.toVerifying();
    m.verifyOutcome();
    expect(m.state.outcomeVerification).not.toBeNull();

    const updated = h.core.missions.updateMission(
      h.ctx(),
      m.id,
      m.state.version,
      { outcome: 'Changed goal' },
    );
    m.state = updated.mission;
    expect(m.state.outcomeVerification).toBeNull();
    expect(guardFailures(() => complete(m))).toEqual(['outcome-verified']);

    m.verifyOutcome();
    m.go('running');
    expect(m.state.outcomeVerification).toBeNull();
  });

  it('can only record outcome evidence while verifying', () => {
    const h = createHarness();
    const m = MissionDriver.create(h);
    expect(() => m.verifyOutcome()).toThrow(CommandNotAllowedError);
  });

  it('can reopen for reconciliation without erasing the completion event', () => {
    const h = createHarness();
    const m = MissionDriver.create(h);
    m.toVerifying();
    m.verifyOutcome();
    complete(m);
    m.go('reconciling');

    expect(m.state.state).toBe('reconciling');
    const types = h.core.missions
      .activity('ws_test', m.id, { afterVersion: 0, limit: 50 })
      .items.filter((i) => i.type === 'mission.transitioned')
      .map((i) => i.stateAfter);
    expect(types).toContain('completed');
    // Back to completed only through verifying again.
    expect(() => complete(m)).toThrow(InvalidTransitionError);
  });
});

describe('producer and verifier are different principals', () => {
  it('rejects packet verification by the principal who reported the attempt', () => {
    const h = createHarness();
    const m = MissionDriver.create(h);
    m.go('ready');
    const a = m.addPacket('Build');
    m.authorize(a);
    h.pool.online = ['prn_runner'];
    m.tick();
    // A human reports on the runner's behalf, then tries to verify their own report.
    m.refresh();
    const attemptId = m.state.packets[0]?.activeAttemptId ?? '';
    const reported = h.core.missions.reportAttempt(
      h.ctx(h.owner),
      m.id,
      m.state.version,
      attemptId,
      'succeeded',
      null,
    );
    m.state = reported.mission;

    expect(() => m.verifyPacket(a, h.owner)).toThrow(SelfVerificationError);
    expect(m.verifyPacket(a, h.cos).packets[0]?.status).toBe('verified');
  });

  it('rejects outcome verification by a principal who reported an attempt', () => {
    const h = createHarness();
    const m = MissionDriver.create(h);
    m.go('ready');
    const a = m.addPacket('Build');
    m.authorize(a);
    h.pool.online = ['prn_runner'];
    m.tick();
    m.refresh();
    const attemptId = m.state.packets[0]?.activeAttemptId ?? '';
    m.state = h.core.missions.reportAttempt(
      h.ctx(h.owner),
      m.id,
      m.state.version,
      attemptId,
      'succeeded',
      null,
    ).mission;
    m.verifyPacket(a, h.cos);
    m.go('verifying');

    expect(() => m.verifyOutcome(h.owner)).toThrow(SelfVerificationError);
    expect(m.verifyOutcome(h.cos).outcomeVerification?.by).toBe('prn_cos');
  });
});

describe('parents and children', () => {
  it('requires every required child to be completed before the parent completes', () => {
    const h = createHarness();
    const parent = MissionDriver.create(h);
    const child = MissionDriver.create(
      h,
      mission({ title: 'Child', parentId: parent.id }),
    );
    const optional = MissionDriver.create(
      h,
      mission({
        title: 'Optional child',
        parentId: parent.id,
        requiredForParent: false,
      }),
    );
    parent.toVerifying();
    parent.verifyOutcome();

    expect(guardFailures(() => complete(parent))).toEqual([
      'required-children-completed',
    ]);

    child.toVerifying();
    child.verifyOutcome();
    complete(child);

    expect(complete(parent).state).toBe('completed');
    expect(optional.refresh().state).toBe('draft');
  });

  it('does not count a child that is only waiting on its own verification', () => {
    const h = createHarness();
    const parent = MissionDriver.create(h);
    const child = MissionDriver.create(h, mission({ parentId: parent.id }));
    child.toVerifying();
    parent.toVerifying();
    parent.verifyOutcome();

    expect(child.refresh().state).toBe('verifying');
    expect(guardFailures(() => complete(parent))).toEqual([
      'required-children-completed',
    ]);
  });

  it('treats a cancelled required child as a dropped scope, not as a blocker', () => {
    const h = createHarness();
    const parent = MissionDriver.create(h);
    const child = MissionDriver.create(h, mission({ parentId: parent.id }));
    child.go('cancelled');
    parent.toVerifying();

    // The parent still needs its own outcome evidence.
    expect(guardFailures(() => complete(parent))).toEqual(['outcome-verified']);
    parent.verifyOutcome();
    expect(complete(parent).state).toBe('completed');
  });
});

describe('registered completion guards', () => {
  it('runs a guard registered after startup', () => {
    const h = createHarness();
    h.core.guards.register({
      name: 'required-links-closed',
      check: ({ mission: m }) =>
        m.links.some((l) => l.classification === 'required')
          ? { ok: false, reason: 'a required issue is still open' }
          : { ok: true },
    });
    const m = MissionDriver.create(
      h,
      mission({
        links: [
          {
            url: 'https://example.com/i/1',
            classification: 'required',
            title: null,
          },
        ],
      }),
    );
    m.toVerifying();
    m.verifyOutcome();

    expect(guardFailures(() => complete(m))).toEqual(['required-links-closed']);
  });

  it('fails closed when a guard throws', () => {
    const h = createHarness();
    h.core.guards.register({
      name: 'flaky-provider',
      check: () => {
        throw new Error('provider outage');
      },
    });
    const m = MissionDriver.create(h);
    m.toVerifying();
    m.verifyOutcome();

    expect(guardFailures(() => complete(m))).toEqual(['flaky-provider']);
  });

  it('rejects a duplicate guard name', () => {
    const h = createHarness();
    expect(() =>
      h.core.guards.register({
        name: 'outcome-verified',
        check: () => ({ ok: true }),
      }),
    ).toThrow(/already registered/);
  });
});

describe('cancel', () => {
  it('cancels the mission, its packets and live attempts, and keeps verified work', () => {
    const h = createHarness();
    const m = MissionDriver.create(
      h,
      mission({
        links: [
          {
            url: 'https://example.com/i/9',
            classification: 'required',
            title: 'Issue',
          },
        ],
      }),
    );
    m.go('ready');
    const a = m.addPacket('A');
    const b = m.addPacket('B');
    const c = m.addPacket('C', { dependsOn: [b] });
    m.authorize(a);
    m.authorize(b);
    finishPacket(h, m, a);
    m.tick();
    const linksBefore = structuredClone(m.state.links);

    const cancelled = h.core.missions.cancelMission(
      h.ctx(),
      m.id,
      m.state.version,
      'no longer needed',
    );

    expect(cancelled.mission.state).toBe('cancelled');
    expect(cancelled.mission.cancelledAt).not.toBeNull();
    const status = Object.fromEntries(
      cancelled.mission.packets.map((p) => [p.id, p.status]),
    );
    expect(status).toEqual({
      [a]: 'verified',
      [b]: 'cancelled',
      [c]: 'cancelled',
    });
    expect(cancelled.mission.attempts.map((x) => x.status)).toEqual([
      'self-reported-succeeded',
      'cancelled',
    ]);
    // Links are data. Cancelling leaves them exactly as they were, and nothing else is written.
    expect(cancelled.mission.links).toEqual(linksBefore);
    const last = h.core.missions.activity('ws_test', m.id, {
      afterVersion: cancelled.event.version - 1,
      limit: 10,
    }).items;
    expect(last).toEqual([
      expect.objectContaining({
        type: 'mission.transitioned',
        payload: { to: 'cancelled', reason: 'no longer needed' },
      }),
    ]);
  });

  it('is refused for a completed mission', () => {
    const h = createHarness();
    const m = MissionDriver.create(h);
    m.toVerifying();
    m.verifyOutcome();
    complete(m);
    expect(() =>
      h.core.missions.cancelMission(h.ctx(), m.id, m.state.version, null),
    ).toThrow(InvalidTransitionError);
  });

  it('is idempotent under a repeated key', () => {
    const h = createHarness();
    const m = MissionDriver.create(h);
    const ctx = h.ctx(h.owner, { idempotencyKey: 'cancel-1' });
    h.core.missions.cancelMission(ctx, m.id, 1, null);
    const repeat = h.core.missions.cancelMission(ctx, m.id, 1, null);
    expect(repeat.replayed).toBe(true);
    expect(repeat.mission.state).toBe('cancelled');
  });
});

// Walks the shortest legal path from draft to `target`.
function reach(m: MissionDriver, target: MissionStatus) {
  const paths: Record<string, MissionStatus[]> = {
    draft: [],
    planning: ['planning'],
    ready: ['ready'],
    running: ['ready', 'running'],
    'waiting-runner': ['ready', 'waiting-runner'],
    'waiting-decision': ['ready', 'waiting-decision'],
    'waiting-external': ['ready', 'waiting-external'],
    reconciling: ['ready', 'verifying', 'reconciling'],
    'needs-attention': ['ready', 'needs-attention'],
  };
  for (const step of paths[target] ?? []) {
    m.go(step);
  }
}
