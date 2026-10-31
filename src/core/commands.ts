import { cycleIfAdded } from './dependency-graph.js';
import {
  AttemptNotFoundError,
  CommandNotAllowedError,
  CompletionGuardFailedError,
  DependencyCycleError,
  ForbiddenActorError,
  PacketNotFoundError,
  SelfVerificationError,
  ValidationError,
} from './errors.js';
import type { CompletionGuardRegistry } from './guards.js';
import type { AddPacketInput } from './inputs.js';
import {
  MISSION_CHANGE_KEYS,
  type MissionChanges,
  type MissionEventPayloads,
} from './reducer.js';
import {
  assertAttemptTransition,
  assertMissionTransition,
  assertPacketTransition,
} from './transitions.js';
import type {
  Actor,
  ExecutionAttempt,
  MissionState,
  MissionStatus,
  WorkPacket,
} from './types.js';
import { LIMITS } from './validation.js';

export interface CheckEnv {
  actor: Actor;
  /** Loaded on demand: only the completion check needs the children. */
  children(): MissionState[];
  guards: CompletionGuardRegistry;
  /**
   * Resolves and evaluates the policy refs a chief of staff cites for a packet against the latest
   * committed policy. Returns why they fail, or `undefined` when every one holds.
   */
  refusePolicyRefs(
    state: MissionState,
    packet: WorkPacket,
    policyRefs: readonly string[],
  ): string | undefined;
}

/**
 * What a command wants to record, plus the state-dependent rules it must pass.
 * The payload is built from the request alone, so a replayed idempotent request
 * produces an identical payload. `check` runs only for a new event, against the
 * state before it, and throws a typed error to refuse it.
 */
export interface Decision<
  T extends keyof MissionEventPayloads = keyof MissionEventPayloads,
> {
  type: T;
  payload: MissionEventPayloads[T];
  evidenceRefs?: readonly string[];
  policyRefs?: readonly string[];
  check(state: MissionState, env: CheckEnv): void;
}

type Kind = Actor['kind'];
const WRITERS: readonly Kind[] = ['human', 'chief_of_staff'];
const EXECUTION_REPORTERS: readonly Kind[] = [
  'human',
  'chief_of_staff',
  'runner',
];

/** Mission states in which the work breakdown may still change. */
const BREAKDOWN_LOCKED: readonly MissionStatus[] = [
  'verifying',
  'reconciling',
  'completed',
  'cancelled',
];

function requireKind(actor: Actor, command: string, kinds: readonly Kind[]) {
  if (!kinds.includes(actor.kind)) {
    throw new ForbiddenActorError(command, actor.kind);
  }
}

/** Only a human or a chief of staff may change mission state. Runners and adapters report, never decide. */
export function requireWriter(actor: Actor, command: string): void {
  requireKind(actor, command, WRITERS);
}

function packetIn(state: MissionState, packetId: string): WorkPacket {
  const packet = state.packets.find((p) => p.id === packetId);
  if (packet === undefined) {
    throw new PacketNotFoundError(packetId);
  }
  return packet;
}

/** A runner may only act on an attempt dispatched to it. A human or chief of staff may report on its behalf. */
function requireAttemptRunner(actor: Actor, attempt: ExecutionAttempt): void {
  if (actor.kind === 'runner' && actor.id !== attempt.runnerId) {
    throw new ForbiddenActorError(
      "act on another runner's attempt",
      actor.kind,
    );
  }
}

function attemptIn(state: MissionState, attemptId: string): ExecutionAttempt {
  const attempt = state.attempts.find((a) => a.id === attemptId);
  if (attempt === undefined) {
    throw new AttemptNotFoundError(attemptId);
  }
  return attempt;
}

function requireBreakdownOpen(state: MissionState, command: string): void {
  if (BREAKDOWN_LOCKED.includes(state.state)) {
    throw new CommandNotAllowedError(
      command,
      `the mission is ${state.state}; move it back to running or ready first`,
    );
  }
}

/** Principals that reported any attempt of the mission. They cannot verify their own work. */
function producers(state: MissionState, packetId?: string): Set<string> {
  const ids = new Set<string>();
  for (const attempt of state.attempts) {
    if (
      attempt.report !== null &&
      (packetId === undefined || attempt.packetId === packetId)
    ) {
      ids.add(attempt.report.by);
    }
  }
  return ids;
}

function requireEvidence(refs: readonly string[]): void {
  if (refs.length === 0) {
    throw new ValidationError([
      { path: 'evidenceRefs', message: 'needs at least one reference' },
    ]);
  }
}

export function updateDecision(
  changes: MissionChanges,
): Decision<'mission.updated'> {
  return {
    type: 'mission.updated',
    payload: { changes },
    check(state, env) {
      requireWriter(env.actor, 'update a mission');
      const unknown = Object.keys(changes).filter(
        (key) => !(MISSION_CHANGE_KEYS as readonly string[]).includes(key),
      );
      if (unknown.length > 0) {
        throw new ValidationError(
          unknown.map((path) => ({ path, message: 'cannot be updated' })),
        );
      }
      if (MISSION_CHANGE_KEYS.every((key) => changes[key] === undefined)) {
        throw new ValidationError([
          { path: '', message: 'must change at least one field' },
        ]);
      }
      if (state.state === 'completed' || state.state === 'cancelled') {
        throw new CommandNotAllowedError(
          'update',
          `the mission is ${state.state}`,
        );
      }
    },
  };
}

/**
 * Covers every mission state change a person asks for, cancellation included.
 * `completed` is only legal from `verifying` (the table) and only when every
 * registered guard passes (here).
 */
export function transitionDecision(
  to: MissionStatus,
  reason: string | null,
): Decision<'mission.transitioned'> {
  return {
    type: 'mission.transitioned',
    payload: { to, reason },
    check(state, env) {
      requireWriter(env.actor, `move a mission to ${to}`);
      assertMissionTransition(state.id, state.state, to);
      if (to === 'completed') {
        const failures = env.guards.evaluate({
          mission: state,
          children: env.children(),
        });
        if (failures.length > 0) {
          throw new CompletionGuardFailedError(state.id, failures);
        }
      }
    },
  };
}

export function verifyOutcomeDecision(
  evidenceRefs: readonly string[],
): Decision<'mission.outcome_verified'> {
  return {
    type: 'mission.outcome_verified',
    payload: {},
    evidenceRefs,
    check(state, env) {
      requireWriter(env.actor, 'verify an outcome');
      requireEvidence(evidenceRefs);
      if (state.state !== 'verifying') {
        throw new CommandNotAllowedError(
          'verify an outcome',
          `the mission is ${state.state}, not verifying`,
        );
      }
      if (producers(state).has(env.actor.id)) {
        throw new SelfVerificationError('Outcome verification');
      }
    },
  };
}

export function addPacketDecision(
  packetId: string,
  input: AddPacketInput,
): Decision<'packet.added'> {
  return {
    type: 'packet.added',
    payload: { packetId, ...input },
    check(state, env) {
      requireWriter(env.actor, 'add a work packet');
      requireBreakdownOpen(state, 'add a work packet');
      if (state.packets.length >= LIMITS.packets) {
        throw new CommandNotAllowedError(
          'add a work packet',
          `a mission holds at most ${LIMITS.packets} packets`,
        );
      }
      const unknown = input.dependsOn.filter(
        (id) => !state.packets.some((p) => p.id === id),
      );
      if (unknown.length > 0) {
        throw new ValidationError([
          {
            path: 'dependsOn',
            message: `names packets not in this mission: ${unknown.join(', ')}`,
          },
        ]);
      }
    },
  };
}

export function addDependencyDecision(
  packetId: string,
  dependsOnPacketId: string,
): Decision<'packet.dependency_added'> {
  return {
    type: 'packet.dependency_added',
    payload: { packetId, dependsOnPacketId },
    check(state, env) {
      requireWriter(env.actor, 'add a dependency');
      requireBreakdownOpen(state, 'add a dependency');
      const packet = packetIn(state, packetId);
      packetIn(state, dependsOnPacketId);
      if (packet.status !== 'pending') {
        throw new CommandNotAllowedError(
          'add a dependency',
          `packet ${packetId} is ${packet.status}; only pending packets can gain prerequisites`,
        );
      }
      if (packet.dependsOn.includes(dependsOnPacketId)) {
        throw new CommandNotAllowedError(
          'add a dependency',
          'the dependency already exists',
        );
      }
      const cycle = cycleIfAdded(state.packets, packetId, dependsOnPacketId);
      if (cycle !== undefined) {
        throw new DependencyCycleError(cycle);
      }
    },
  };
}

export function authorizePacketDecision(
  packetId: string,
  policyRefs: readonly string[],
): Decision<'packet.authorized'> {
  return {
    type: 'packet.authorized',
    payload: { packetId },
    policyRefs,
    check(state, env) {
      requireWriter(env.actor, 'authorize a work packet');
      requireBreakdownOpen(state, 'authorize a work packet');
      const packet = packetIn(state, packetId);
      if (packet.status !== 'pending' || packet.authorization !== null) {
        throw new CommandNotAllowedError(
          'authorize a work packet',
          `packet ${packetId} is ${packet.status}${packet.authorization === null ? '' : ' and already authorized'}`,
        );
      }
      // A cited ref is a claim. A chief of staff acts only under a rule that is current now, so
      // each ref is resolved and evaluated here, where the authorization takes effect.
      if (env.actor.kind === 'chief_of_staff') {
        const refusal = env.refusePolicyRefs(state, packet, policyRefs);
        if (refusal !== undefined) {
          throw new CommandNotAllowedError('authorize a work packet', refusal);
        }
      }
    },
  };
}

export function verifyPacketDecision(
  packetId: string,
  evidenceRefs: readonly string[],
): Decision<'packet.verified'> {
  return {
    type: 'packet.verified',
    payload: { packetId },
    evidenceRefs,
    check(state, env) {
      requireWriter(env.actor, 'verify a work packet');
      requireEvidence(evidenceRefs);
      const packet = packetIn(state, packetId);
      assertPacketTransition(packet.id, packet.status, 'verified');
      if (producers(state, packetId).has(env.actor.id)) {
        throw new SelfVerificationError('Work packet verification');
      }
    },
  };
}

export function rejectPacketDecision(
  packetId: string,
  reason: string | null,
): Decision<'packet.rejected'> {
  return {
    type: 'packet.rejected',
    payload: { packetId, reason },
    check(state, env) {
      requireWriter(env.actor, 'reject a work packet');
      const packet = packetIn(state, packetId);
      if (packet.status !== 'reported') {
        throw new CommandNotAllowedError(
          'reject a work packet',
          `packet ${packetId} is ${packet.status}, not reported`,
        );
      }
    },
  };
}

export function requeuePacketDecision(
  packetId: string,
): Decision<'packet.requeued'> {
  return {
    type: 'packet.requeued',
    payload: { packetId },
    check(state, env) {
      requireWriter(env.actor, 'requeue a work packet');
      const packet = packetIn(state, packetId);
      assertPacketTransition(packet.id, packet.status, 'pending');
    },
  };
}

export function startAttemptDecision(
  attemptId: string,
): Decision<'attempt.started'> {
  return {
    type: 'attempt.started',
    payload: { attemptId },
    check(state, env) {
      requireKind(env.actor, 'start an attempt', EXECUTION_REPORTERS);
      const attempt = attemptIn(state, attemptId);
      requireAttemptRunner(env.actor, attempt);
      assertAttemptTransition(attempt.id, attempt.status, 'running');
    },
  };
}

export function reportAttemptDecision(
  attemptId: string,
  outcome: 'succeeded' | 'failed',
  summary: string | null,
): Decision<'attempt.reported'> {
  return {
    type: 'attempt.reported',
    payload: { attemptId, outcome, summary },
    check(state, env) {
      requireKind(env.actor, 'report an attempt', EXECUTION_REPORTERS);
      const attempt = attemptIn(state, attemptId);
      requireAttemptRunner(env.actor, attempt);
      assertAttemptTransition(
        attempt.id,
        attempt.status,
        outcome === 'succeeded'
          ? 'self-reported-succeeded'
          : 'self-reported-failed',
      );
    },
  };
}

/** Scheduler decisions. They share the transition tables with every other command. */
export function readyPacketDecision(
  packetId: string,
): Decision<'packet.readied'> {
  return {
    type: 'packet.readied',
    payload: { packetId },
    check(state, env) {
      requireWriter(env.actor, 'schedule work');
      const packet = packetIn(state, packetId);
      assertPacketTransition(packet.id, packet.status, 'ready');
    },
  };
}

export function dispatchAttemptDecision(
  attemptId: string,
  packetId: string,
  runnerId: string,
): Decision<'attempt.dispatched'> {
  return {
    type: 'attempt.dispatched',
    payload: { attemptId, packetId, runnerId },
    check(state, env) {
      requireWriter(env.actor, 'schedule work');
      const packet = packetIn(state, packetId);
      assertPacketTransition(packet.id, packet.status, 'leased');
    },
  };
}
