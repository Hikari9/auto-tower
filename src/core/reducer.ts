import type { StoredEvent } from '../events/event-log.js';
import type {
  DoneItem,
  ExecutionAttempt,
  IssueLinkRef,
  MissionState,
  MissionStatus,
  Priority,
  Risk,
  Size,
  WorkPacket,
} from './types.js';

/** Fields a `mission.updated` event may change. */
/** The only fields a `mission.updated` event may carry. Anything else is refused before it is recorded. */
export const MISSION_CHANGE_KEYS = [
  'title',
  'intent',
  'outcome',
  'constraints',
  'risk',
  'size',
  'priority',
  'definitionOfDone',
  'links',
  'policyRefs',
] as const;

export interface MissionChanges {
  title?: string;
  intent?: string;
  outcome?: string;
  constraints?: string[];
  risk?: Risk;
  size?: Size;
  priority?: Priority;
  definitionOfDone?: DoneItem[];
  links?: IssueLinkRef[];
  policyRefs?: string[];
}

export interface MissionCreatedPayload {
  title: string;
  intent: string;
  outcome: string;
  constraints: string[];
  risk: Risk;
  size: Size;
  priority: Priority;
  definitionOfDone: DoneItem[];
  source: string;
  parentId: string | null;
  requiredForParent: boolean;
  links: IssueLinkRef[];
  policyRefs: string[];
}

/**
 * Payloads of every event in a mission stream. Request-derived data only, so a replayed
 * idempotent request hashes the same as the first. The scheduler alone adds `at`, the tick time.
 */
export interface MissionEventPayloads {
  'mission.created': MissionCreatedPayload;
  'mission.updated': { changes: MissionChanges };
  'mission.transitioned': { to: MissionStatus; reason: string | null };
  'mission.outcome_verified': Record<string, never>;
  'packet.added': {
    packetId: string;
    title: string;
    instructions: string;
    scope: string[];
    required: boolean;
    dependsOn: string[];
  };
  'packet.dependency_added': { packetId: string; dependsOnPacketId: string };
  'packet.authorized': { packetId: string };
  'packet.readied': { packetId: string };
  'packet.verified': { packetId: string };
  'packet.rejected': { packetId: string; reason: string | null };
  'packet.requeued': { packetId: string };
  'attempt.dispatched': {
    attemptId: string;
    packetId: string;
    runnerId: string;
  };
  'attempt.started': { attemptId: string };
  'attempt.reported': {
    attemptId: string;
    outcome: 'succeeded' | 'failed';
    summary: string | null;
  };
}

export type MissionEventType = keyof MissionEventPayloads;

export class CorruptStreamError extends Error {
  override readonly name = 'CorruptStreamError';
}

const STREAM_PREFIX = 'mission:';

export function missionIdOfStream(streamId: string): string {
  if (!streamId.startsWith(STREAM_PREFIX)) {
    throw new CorruptStreamError(`Stream ${streamId} is not a mission stream`);
  }
  return streamId.slice(STREAM_PREFIX.length);
}

/** The scheduler stamps its events with the injected clock. Everything else uses the recording time. */
function occurredAt(event: StoredEvent): string {
  const at = (event.payload as { at?: unknown }).at;
  return typeof at === 'string' ? at : event.recordedAt;
}

function packetOf(state: MissionState, packetId: string): WorkPacket {
  const packet = state.packets.find((p) => p.id === packetId);
  if (packet === undefined) {
    throw new CorruptStreamError(`Event names unknown packet ${packetId}`);
  }
  return packet;
}

function attemptOf(state: MissionState, attemptId: string): ExecutionAttempt {
  const attempt = state.attempts.find((a) => a.id === attemptId);
  if (attempt === undefined) {
    throw new CorruptStreamError(`Event names unknown attempt ${attemptId}`);
  }
  return attempt;
}

/**
 * Applies one event to a state and returns the new state. Pure: the input is not
 * modified. It never re-checks guards or transition rules, because those ran when the
 * event was accepted and a replay must reproduce history, not re-judge it.
 */
export function applyEvent(
  previous: MissionState | undefined,
  event: StoredEvent,
): MissionState {
  const at = occurredAt(event);
  if (event.type === 'mission.created') {
    if (previous !== undefined) {
      throw new CorruptStreamError('mission.created appears twice');
    }
    return created(event, at);
  }
  if (previous === undefined) {
    throw new CorruptStreamError(`${event.type} precedes mission.created`);
  }
  const state = structuredClone(previous);
  applyInPlace(state, event, at);
  return state;
}

/**
 * State must never share arrays or objects with an event: replay mutates state in place,
 * and a shared payload array would rewrite the history that was read from the log.
 */
function isolate(event: StoredEvent): StoredEvent {
  return {
    ...event,
    payload: structuredClone(event.payload),
    policyRefs: [...event.policyRefs],
    evidenceRefs: [...event.evidenceRefs],
  };
}

/** Mutates `state`. Replay uses it directly, so a long stream is not copied once per event. */
function applyInPlace(
  state: MissionState,
  recorded: StoredEvent,
  at: string,
): void {
  const event = isolate(recorded);
  state.version = event.version;
  state.updatedAt = at;
  for (const ref of event.evidenceRefs) {
    if (!state.evidenceRefs.includes(ref)) {
      state.evidenceRefs.push(ref);
    }
  }

  const type = event.type as MissionEventType;
  switch (type) {
    case 'mission.updated': {
      const { changes } = event.payload as MissionEventPayloads[typeof type];
      let changed = false;
      for (const key of MISSION_CHANGE_KEYS) {
        if (changes[key] !== undefined) {
          Object.assign(state, { [key]: changes[key] });
          changed = true;
        }
      }
      if (changed) {
        // Changing what was verified invalidates the verification.
        state.outcomeVerification = null;
      }
      break;
    }
    case 'mission.transitioned': {
      const { to } = event.payload as MissionEventPayloads[typeof type];
      transitionMission(state, to, at);
      break;
    }
    case 'mission.outcome_verified':
      state.outcomeVerification = {
        at,
        by: event.actorId,
        evidenceRefs: [...event.evidenceRefs],
      };
      break;
    case 'packet.added': {
      const p = event.payload as MissionEventPayloads[typeof type];
      state.packets.push({
        id: p.packetId,
        missionId: state.id,
        position: state.packets.length + 1,
        title: p.title,
        instructions: p.instructions,
        scope: p.scope,
        required: p.required,
        status: 'pending',
        dependsOn: p.dependsOn,
        authorization: null,
        verification: null,
        activeAttemptId: null,
        createdAt: at,
        updatedAt: at,
      });
      // New required work means the earlier outcome check no longer covers the mission.
      state.outcomeVerification = null;
      break;
    }
    case 'packet.dependency_added': {
      const p = event.payload as MissionEventPayloads[typeof type];
      const packet = packetOf(state, p.packetId);
      packet.dependsOn.push(p.dependsOnPacketId);
      packet.updatedAt = at;
      break;
    }
    case 'packet.authorized': {
      const packet = packetOf(
        state,
        (event.payload as MissionEventPayloads[typeof type]).packetId,
      );
      packet.authorization = {
        at,
        by: event.actorId,
        policyRefs: [...event.policyRefs],
      };
      packet.updatedAt = at;
      break;
    }
    case 'packet.readied':
      setPacket(
        state,
        (event.payload as MissionEventPayloads[typeof type]).packetId,
        'ready',
        at,
      );
      break;
    case 'packet.verified': {
      const packet = setPacket(
        state,
        (event.payload as MissionEventPayloads[typeof type]).packetId,
        'verified',
        at,
      );
      packet.verification = {
        at,
        by: event.actorId,
        evidenceRefs: [...event.evidenceRefs],
      };
      break;
    }
    case 'packet.rejected':
      setPacket(
        state,
        (event.payload as MissionEventPayloads[typeof type]).packetId,
        'failed',
        at,
      );
      break;
    case 'packet.requeued': {
      const packet = setPacket(
        state,
        (event.payload as MissionEventPayloads[typeof type]).packetId,
        'pending',
        at,
      );
      // A packet that failed needs a fresh authorization before it runs again.
      packet.authorization = null;
      break;
    }
    case 'attempt.dispatched': {
      const p = event.payload as MissionEventPayloads[typeof type];
      const packet = setPacket(state, p.packetId, 'leased', at);
      packet.activeAttemptId = p.attemptId;
      state.attempts.push({
        id: p.attemptId,
        missionId: state.id,
        packetId: p.packetId,
        number:
          state.attempts.filter((a) => a.packetId === p.packetId).length + 1,
        runnerId: p.runnerId,
        status: 'leased',
        dispatchedAt: at,
        startedAt: null,
        reportedAt: null,
        report: null,
      });
      break;
    }
    case 'attempt.started': {
      const attempt = attemptOf(
        state,
        (event.payload as MissionEventPayloads[typeof type]).attemptId,
      );
      attempt.status = 'running';
      attempt.startedAt = at;
      setPacket(state, attempt.packetId, 'running', at);
      break;
    }
    case 'attempt.reported': {
      const p = event.payload as MissionEventPayloads[typeof type];
      const attempt = attemptOf(state, p.attemptId);
      const succeeded = p.outcome === 'succeeded';
      attempt.status = succeeded
        ? 'self-reported-succeeded'
        : 'self-reported-failed';
      attempt.reportedAt = at;
      attempt.report = {
        outcome: p.outcome,
        summary: p.summary,
        by: event.actorId,
      };
      const packet = setPacket(
        state,
        attempt.packetId,
        succeeded ? 'reported' : 'failed',
        at,
      );
      packet.activeAttemptId = null;
      break;
    }
    default:
      throw new CorruptStreamError(`Unknown event type ${event.type}`);
  }
}

function created(recorded: StoredEvent, at: string): MissionState {
  const event = isolate(recorded);
  const p = event.payload as MissionEventPayloads['mission.created'];
  return {
    id: missionIdOfStream(event.streamId),
    workspaceId: event.workspaceId,
    version: event.version,
    state: 'draft',
    title: p.title,
    intent: p.intent,
    outcome: p.outcome,
    constraints: p.constraints,
    risk: p.risk,
    size: p.size,
    priority: p.priority,
    definitionOfDone: p.definitionOfDone,
    source: p.source,
    createdBy: event.actorId,
    parentId: p.parentId,
    requiredForParent: p.requiredForParent,
    links: p.links,
    policyRefs: p.policyRefs,
    evidenceRefs: [...new Set(event.evidenceRefs)],
    outcomeVerification: null,
    createdAt: at,
    updatedAt: at,
    completedAt: null,
    cancelledAt: null,
    packets: [],
    attempts: [],
  };
}

function setPacket(
  state: MissionState,
  packetId: string,
  status: WorkPacket['status'],
  at: string,
): WorkPacket {
  const packet = packetOf(state, packetId);
  packet.status = status;
  packet.updatedAt = at;
  return packet;
}

function transitionMission(
  state: MissionState,
  to: MissionStatus,
  at: string,
): void {
  const from = state.state;
  state.state = to;
  if ((from === 'verifying' && to !== 'completed') || from === 'completed') {
    // Leaving verification for rework, or reopening a completed mission, discards the
    // verdict. Completing again needs fresh evidence. The completion event stays in history.
    state.outcomeVerification = null;
  }
  if (to === 'completed') {
    state.completedAt = at;
  } else if (from === 'completed') {
    state.completedAt = null;
  }
  if (to === 'cancelled') {
    state.cancelledAt = at;
    // Cancelling stops Tower's own work. It reaches nothing outside Tower.
    for (const packet of state.packets) {
      if (packet.status !== 'verified' && packet.status !== 'cancelled') {
        packet.status = 'cancelled';
        packet.updatedAt = at;
        packet.activeAttemptId = null;
      }
    }
    for (const attempt of state.attempts) {
      if (attempt.status === 'leased' || attempt.status === 'running') {
        attempt.status = 'cancelled';
      }
    }
  }
}

/** Rebuilds a mission from its stream, optionally only up to `version`. Throws on an empty or malformed stream. */
export function replay(
  events: readonly StoredEvent[],
  version = Number.POSITIVE_INFINITY,
): MissionState {
  let state: MissionState | undefined;
  for (const event of events) {
    if (event.version > version) {
      break;
    }
    if (state === undefined || event.type === 'mission.created') {
      state = applyEvent(state, event);
    } else {
      applyInPlace(state, event, occurredAt(event));
    }
  }
  if (state === undefined) {
    throw new CorruptStreamError('A mission stream has no events');
  }
  return state;
}

/** The mission state after each event, in order. Index 0 is the state at version 1. */
export function statesAfterEach(
  events: readonly StoredEvent[],
): MissionStatus[] {
  const out: MissionStatus[] = [];
  let state: MissionState | undefined;
  for (const event of events) {
    if (state === undefined || event.type === 'mission.created') {
      state = applyEvent(state, event);
    } else {
      applyInPlace(state, event, occurredAt(event));
    }
    out.push(state.state);
  }
  return out;
}
