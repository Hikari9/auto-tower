import { describe, expect, it } from 'vitest';
import { InvalidTransitionError } from '../../src/core/errors.js';
import {
  ATTEMPT_TRANSITIONS,
  MISSION_TRANSITIONS,
  PACKET_TRANSITIONS,
} from '../../src/core/transitions.js';
import {
  ATTEMPT_STATUSES,
  MISSION_STATUSES,
  PACKET_STATUSES,
} from '../../src/core/types.js';
import { createHarness, type Harness, MissionDriver } from './helpers.js';

// The tables are written out in full here on purpose. Changing a transition must change this file too.
describe('transition tables', () => {
  it('pins the mission table', () => {
    expect(MISSION_TRANSITIONS).toEqual({
      draft: ['planning', 'ready', 'cancelled'],
      planning: ['ready', 'waiting-decision', 'needs-attention', 'cancelled'],
      ready: [
        'planning',
        'running',
        'waiting-runner',
        'waiting-decision',
        'waiting-external',
        'verifying',
        'needs-attention',
        'cancelled',
      ],
      running: [
        'ready',
        'waiting-runner',
        'waiting-decision',
        'waiting-external',
        'verifying',
        'needs-attention',
        'cancelled',
      ],
      'waiting-runner': [
        'ready',
        'running',
        'waiting-decision',
        'waiting-external',
        'verifying',
        'needs-attention',
        'cancelled',
      ],
      'waiting-decision': [
        'planning',
        'ready',
        'running',
        'waiting-runner',
        'waiting-external',
        'verifying',
        'needs-attention',
        'cancelled',
      ],
      'waiting-external': [
        'ready',
        'running',
        'waiting-runner',
        'waiting-decision',
        'verifying',
        'needs-attention',
        'cancelled',
      ],
      verifying: [
        'ready',
        'running',
        'reconciling',
        'completed',
        'needs-attention',
        'cancelled',
      ],
      reconciling: ['verifying', 'needs-attention', 'cancelled'],
      completed: ['reconciling', 'needs-attention'],
      'needs-attention': [
        'planning',
        'ready',
        'running',
        'waiting-runner',
        'waiting-decision',
        'waiting-external',
        'verifying',
        'cancelled',
      ],
      cancelled: [],
    });
  });

  it('pins the packet table', () => {
    expect(PACKET_TRANSITIONS).toEqual({
      pending: ['ready', 'cancelled'],
      ready: ['leased', 'cancelled'],
      leased: ['running', 'reported', 'failed', 'cancelled'],
      running: ['reported', 'failed', 'cancelled'],
      reported: ['verified', 'failed', 'cancelled'],
      verified: [],
      failed: ['pending', 'cancelled'],
      cancelled: [],
    });
  });

  it('pins the attempt table', () => {
    expect(ATTEMPT_TRANSITIONS).toEqual({
      leased: [
        'running',
        'self-reported-succeeded',
        'self-reported-failed',
        'cancelled',
      ],
      running: ['self-reported-succeeded', 'self-reported-failed', 'cancelled'],
      'self-reported-succeeded': [],
      'self-reported-failed': [],
      cancelled: [],
    });
  });

  it('covers every status as a key and only names real statuses', () => {
    expect(Object.keys(MISSION_TRANSITIONS).sort()).toEqual(
      [...MISSION_STATUSES].sort(),
    );
    expect(Object.keys(PACKET_TRANSITIONS).sort()).toEqual(
      [...PACKET_STATUSES].sort(),
    );
    expect(Object.keys(ATTEMPT_TRANSITIONS).sort()).toEqual(
      [...ATTEMPT_STATUSES].sort(),
    );
  });
});

// Walks a fresh mission to a state, then tries every other state through the service.
const PATH: Record<string, string[]> = {
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
  cancelled: ['cancelled'],
};

describe('mission transitions through the service', () => {
  it('accepts exactly the pairs in the table and rejects every other pair', () => {
    for (const from of Object.keys(PATH)) {
      for (const to of MISSION_STATUSES) {
        if (to === 'completed') {
          continue; // guarded separately in completion.test.ts
        }
        const h = createHarness();
        const m = MissionDriver.create(h);
        for (const step of PATH[from] ?? []) {
          m.go(step as never);
        }
        const allowed =
          MISSION_TRANSITIONS[
            from as keyof typeof MISSION_TRANSITIONS
          ].includes(to);
        const attempt = () => m.go(to);
        if (allowed) {
          expect(attempt, `${from} -> ${to}`).not.toThrow();
          expect(m.state.state).toBe(to);
        } else {
          expect(attempt, `${from} -> ${to}`).toThrow(InvalidTransitionError);
          expect(m.refresh().state).toBe(from);
        }
      }
    }
  });
});

function packetInStatus(h: Harness, status: string) {
  const m = MissionDriver.create(h);
  m.go('ready');
  const a = m.addPacket('A');
  if (status === 'pending') {
    return { m, a };
  }
  m.authorize(a);
  if (status === 'ready') {
    m.tick();
    return { m, a };
  }
  h.pool.online = ['prn_runner'];
  m.tick();
  if (status === 'leased') {
    return { m, a };
  }
  if (status === 'running') {
    const attemptId = m.refresh().packets[0]?.activeAttemptId ?? '';
    m.state = h.core.missions.startAttempt(
      h.ctx(h.runner),
      m.id,
      m.state.version,
      attemptId,
    ).mission;
    return { m, a };
  }
  m.runAttempt(a, status === 'failed' ? 'failed' : 'succeeded');
  if (status === 'verified') {
    m.verifyPacket(a);
  }
  if (status === 'cancelled') {
    m.state = h.core.missions.cancelMission(
      h.ctx(),
      m.id,
      m.state.version,
      null,
    ).mission;
  }
  return { m, a };
}

describe('packet verification', () => {
  it.each([
    'pending',
    'ready',
    'leased',
    'running',
    'failed',
    'verified',
    'cancelled',
  ])('refuses to verify a %s packet', (status) => {
    const h = createHarness();
    const { m, a } = packetInStatus(h, status);
    expect(m.refresh().packets[0]?.status).toBe(status);
    expect(() => m.verifyPacket(a)).toThrow(InvalidTransitionError);
  });

  it('verifies a reported packet', () => {
    const h = createHarness();
    const { m, a } = packetInStatus(h, 'reported');
    expect(m.verifyPacket(a).packets[0]?.status).toBe('verified');
  });
});
