import { InvalidTransitionError } from './errors.js';
import type { AttemptStatus, MissionStatus, PacketStatus } from './types.js';

/**
 * Every legal mission transition. Anything absent is rejected. `completed` appears
 * under `verifying` only, so no path reaches it without passing the completion guards.
 * A completed mission can re-open for reconciliation or attention, because an external
 * required issue may drift after completion. Cancelled is final.
 */
export const MISSION_TRANSITIONS: Readonly<
  Record<MissionStatus, readonly MissionStatus[]>
> = {
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
};

export const PACKET_TRANSITIONS: Readonly<
  Record<PacketStatus, readonly PacketStatus[]>
> = {
  pending: ['ready', 'cancelled'],
  ready: ['leased', 'cancelled'],
  leased: ['running', 'reported', 'failed', 'cancelled'],
  running: ['reported', 'failed', 'cancelled'],
  reported: ['verified', 'failed', 'cancelled'],
  verified: [],
  failed: ['pending', 'cancelled'],
  cancelled: [],
};

export const ATTEMPT_TRANSITIONS: Readonly<
  Record<AttemptStatus, readonly AttemptStatus[]>
> = {
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
};

export function canTransitionMission(
  from: MissionStatus,
  to: MissionStatus,
): boolean {
  return MISSION_TRANSITIONS[from].includes(to);
}

export function assertMissionTransition(
  missionId: string,
  from: MissionStatus,
  to: MissionStatus,
): void {
  if (!canTransitionMission(from, to)) {
    throw new InvalidTransitionError('mission', missionId, from, to);
  }
}

export function assertPacketTransition(
  packetId: string,
  from: PacketStatus,
  to: PacketStatus,
): void {
  if (!PACKET_TRANSITIONS[from].includes(to)) {
    throw new InvalidTransitionError('packet', packetId, from, to);
  }
}

export function assertAttemptTransition(
  attemptId: string,
  from: AttemptStatus,
  to: AttemptStatus,
): void {
  if (!ATTEMPT_TRANSITIONS[from].includes(to)) {
    throw new InvalidTransitionError('attempt', attemptId, from, to);
  }
}
