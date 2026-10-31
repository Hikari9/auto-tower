import { createHash } from 'node:crypto';
import {
  createEventLog,
  type EventLog,
  type StoredEvent,
} from '../events/event-log.js';
import { newId } from '../shared/ids.js';
import type { SqlDatabase } from '../storage/database.js';
import {
  addDependencyDecision,
  addPacketDecision,
  authorizePacketDecision,
  type CheckEnv,
  type Decision,
  rejectPacketDecision,
  reportAttemptDecision,
  requeuePacketDecision,
  requireWriter,
  startAttemptDecision,
  transitionDecision,
  updateDecision,
  verifyOutcomeDecision,
  verifyPacketDecision,
} from './commands.js';
import {
  CommandNotAllowedError,
  MissionNotFoundError,
  ValidationError,
} from './errors.js';
import type { CompletionGuardRegistry } from './guards.js';
import type { AddPacketInput, CreateMissionInput } from './inputs.js';
import {
  listSchedulableMissionIds,
  loadChildren,
  loadMission,
  type MissionSummary,
  type SearchQuery,
  type SearchResult,
  searchMissions,
  writeProjection,
} from './projection.js';
import {
  applyEvent,
  type MissionChanges,
  type MissionEventPayloads,
  replay,
  statesAfterEach,
} from './reducer.js';
import {
  type Actor,
  type MissionState,
  type MissionStatus,
  missionStreamId,
} from './types.js';

export type { MissionSummary, SearchQuery, SearchResult };

export interface CommandContext {
  workspaceId: string;
  actor: Actor;
  /** Links the events of one logical operation. Defaults to the idempotency key, then a new id. */
  correlationId?: string | undefined;
  /**
   * Scoped to (workspace, actor). A repeat with the same request returns the first result.
   * The same key with a different request is rejected.
   */
  idempotencyKey?: string | undefined;
}

export interface CommandResult {
  /** The mission as of the event. On a replay this is the first call's result, not the current state. */
  mission: MissionState;
  event: StoredEvent;
  replayed: boolean;
}

export interface ActivityItem {
  version: number;
  seq: number;
  type: string;
  actorId: string;
  correlationId: string;
  policyRefs: string[];
  evidenceRefs: string[];
  recordedAt: string;
  payload: unknown;
  /** Mission state once this event was applied. */
  stateAfter: MissionStatus;
}

export interface ActivityPage {
  items: ActivityItem[];
  /** Pass as `afterVersion` to read the next page, or null at the end. */
  nextAfterVersion: number | null;
}

export interface MissionServiceDeps {
  db: SqlDatabase;
  guards: CompletionGuardRegistry;
  /** Id source, injectable so tests and the scheduler are deterministic. */
  newId?: (prefix: string) => string;
  /**
   * Replaying a stream costs time in proportion to its length, so a mission accepts at most
   * this many events. Cancelling is always allowed, so a full mission can still be closed.
   */
  maxEventsPerMission?: number;
}

export const DEFAULT_MAX_EVENTS_PER_MISSION = 5_000;

/**
 * A fresh handle whose `transaction` joins the one already open. The event log opens its own
 * write transaction per append, so without this a command could not make the event and its
 * projection atomic.
 */
function joinTransaction(tx: SqlDatabase): SqlDatabase {
  const joined: SqlDatabase = { ...tx, transaction: (fn) => fn(joined) };
  return joined;
}

/** Same request from the same actor yields the same id, so an idempotent retry names the same entity. */
function derivedId(prefix: string, ctx: CommandContext): string {
  const digest = createHash('sha256')
    .update(`${ctx.workspaceId}\0${ctx.actor.id}\0${ctx.idempotencyKey}`)
    .digest('hex');
  return `${prefix}_${digest.slice(0, 32)}`;
}

export interface MissionService {
  createMission(ctx: CommandContext, input: CreateMissionInput): CommandResult;
  updateMission(
    ctx: CommandContext,
    missionId: string,
    expectedVersion: number,
    changes: MissionChanges,
  ): CommandResult;
  transitionMission(
    ctx: CommandContext,
    missionId: string,
    expectedVersion: number,
    to: MissionStatus,
    reason: string | null,
  ): CommandResult;
  cancelMission(
    ctx: CommandContext,
    missionId: string,
    expectedVersion: number,
    reason: string | null,
  ): CommandResult;
  verifyOutcome(
    ctx: CommandContext,
    missionId: string,
    expectedVersion: number,
    evidenceRefs: readonly string[],
  ): CommandResult;
  addPacket(
    ctx: CommandContext,
    missionId: string,
    expectedVersion: number,
    input: AddPacketInput,
  ): CommandResult;
  addDependency(
    ctx: CommandContext,
    missionId: string,
    expectedVersion: number,
    packetId: string,
    dependsOnPacketId: string,
  ): CommandResult;
  authorizePacket(
    ctx: CommandContext,
    missionId: string,
    expectedVersion: number,
    packetId: string,
    policyRefs: readonly string[],
  ): CommandResult;
  verifyPacket(
    ctx: CommandContext,
    missionId: string,
    expectedVersion: number,
    packetId: string,
    evidenceRefs: readonly string[],
  ): CommandResult;
  rejectPacket(
    ctx: CommandContext,
    missionId: string,
    expectedVersion: number,
    packetId: string,
    reason: string | null,
  ): CommandResult;
  requeuePacket(
    ctx: CommandContext,
    missionId: string,
    expectedVersion: number,
    packetId: string,
  ): CommandResult;
  startAttempt(
    ctx: CommandContext,
    missionId: string,
    expectedVersion: number,
    attemptId: string,
  ): CommandResult;
  reportAttempt(
    ctx: CommandContext,
    missionId: string,
    expectedVersion: number,
    attemptId: string,
    outcome: 'succeeded' | 'failed',
    summary: string | null,
  ): CommandResult;

  getMission(workspaceId: string, missionId: string): MissionState | undefined;
  search(workspaceId: string, query: SearchQuery): SearchResult;
  activity(
    workspaceId: string,
    missionId: string,
    page: { afterVersion: number; limit: number },
  ): ActivityPage;
  /** Rebuilds the mission from its events alone, ignoring the projection. */
  replayMission(workspaceId: string, missionId: string): MissionState;
  /** Rewrites the projection rows of one mission from its events. */
  rebuildProjection(workspaceId: string, missionId: string): MissionState;
  /** Ids the scheduler manages, most urgent first. */
  schedulableMissionIds(
    workspaceId: string,
    states: readonly MissionStatus[],
  ): string[];
  /**
   * Runs `fn` against one mission inside a single transaction. Used by the scheduler, which
   * appends several events per mission. `step` appends one decision and returns the new state.
   */
  withMission<T>(
    workspaceId: string,
    missionId: string,
    actor: Actor,
    fn: (session: MissionSession) => T,
  ): T;
}

export interface MissionSession {
  state: MissionState;
  /** Appends one event at the next version, applies it, and updates the projection. */
  step(
    decision: Decision,
    meta: { correlationId: string; at: string },
  ): StoredEvent;
}

export function createMissionService(deps: MissionServiceDeps): MissionService {
  const { db, guards } = deps;
  const ids = deps.newId ?? newId;
  const maxEvents = deps.maxEventsPerMission ?? DEFAULT_MAX_EVENTS_PER_MISSION;

  function inTransaction<T>(fn: (tx: SqlDatabase, log: EventLog) => T): T {
    return db.transaction((tx) => {
      const joined = joinTransaction(tx);
      return fn(joined, createEventLog(joined));
    });
  }

  function envFor(
    tx: SqlDatabase,
    actor: Actor,
    state: MissionState,
  ): CheckEnv {
    return {
      actor,
      guards,
      children: () => loadChildren(tx, state.workspaceId, state.id),
    };
  }

  function correlation(ctx: CommandContext): string {
    return ctx.correlationId ?? ctx.idempotencyKey ?? ids('cor');
  }

  /** Runs one command on an existing mission. See `appendDecision` for the order of checks. */
  function mutate(
    ctx: CommandContext,
    missionId: string,
    expectedVersion: number,
    decision: Decision,
  ): CommandResult {
    const streamId = missionStreamId(missionId);
    return inTransaction((tx, log) => {
      const events = log.readStream(ctx.workspaceId, streamId);
      if (events.length === 0) {
        throw new MissionNotFoundError(missionId);
      }
      if (events.length >= maxEvents && !isCancel(decision)) {
        throw new CommandNotAllowedError(
          'change a mission',
          `it has reached its limit of ${maxEvents} events; cancel it and start a new one`,
        );
      }
      const result = log.append({
        workspaceId: ctx.workspaceId,
        streamId,
        expectedVersion,
        type: decision.type,
        payload: decision.payload,
        actorId: ctx.actor.id,
        correlationId: correlation(ctx),
        policyRefs: decision.policyRefs ?? [],
        evidenceRefs: decision.evidenceRefs ?? [],
        ...(ctx.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: ctx.idempotencyKey }),
      });
      if (result.replayed) {
        return firstResult(events, result.event);
      }
      const state = replay(events);
      // The event is appended before the checks so an idempotent replay is answered
      // ahead of them. A failed check throws, which rolls the append back.
      decision.check(state, envFor(tx, ctx.actor, state));
      const mission = applyEvent(state, result.event);
      const first = events[0];
      writeProjection(tx, mission, first?.seq ?? result.event.seq);
      return { mission, event: result.event, replayed: false };
    });
  }

  function firstResult(
    events: readonly StoredEvent[],
    event: StoredEvent,
  ): CommandResult {
    return { mission: replay(events, event.version), event, replayed: true };
  }

  function loadEvents(workspaceId: string, missionId: string): StoredEvent[] {
    const events = createEventLog(db).readStream(
      workspaceId,
      missionStreamId(missionId),
    );
    if (events.length === 0) {
      throw new MissionNotFoundError(missionId);
    }
    return events;
  }

  return {
    createMission(ctx, input) {
      const missionId =
        ctx.idempotencyKey === undefined ? ids('msn') : derivedId('msn', ctx);
      const streamId = missionStreamId(missionId);
      return inTransaction((tx, log) => {
        const payload: MissionEventPayloads['mission.created'] = { ...input };
        const result = log.append({
          workspaceId: ctx.workspaceId,
          streamId,
          expectedVersion: 0,
          type: 'mission.created',
          payload,
          actorId: ctx.actor.id,
          correlationId: correlation(ctx),
          policyRefs: input.policyRefs,
          ...(ctx.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: ctx.idempotencyKey }),
        });
        if (result.replayed) {
          return firstResult(
            log.readStream(ctx.workspaceId, streamId),
            result.event,
          );
        }
        requireWriter(ctx.actor, 'create a mission');
        if (input.parentId !== null) {
          checkParent(tx, ctx.workspaceId, input.parentId);
        }
        const mission = applyEvent(undefined, result.event);
        writeProjection(tx, mission, result.event.seq);
        return { mission, event: result.event, replayed: false };
      });
    },

    updateMission: (ctx, id, version, changes) =>
      mutate(ctx, id, version, updateDecision(changes)),
    transitionMission: (ctx, id, version, to, reason) =>
      mutate(ctx, id, version, transitionDecision(to, reason)),
    cancelMission: (ctx, id, version, reason) =>
      mutate(ctx, id, version, transitionDecision('cancelled', reason)),
    verifyOutcome: (ctx, id, version, evidenceRefs) =>
      mutate(ctx, id, version, verifyOutcomeDecision(evidenceRefs)),
    addPacket: (ctx, id, version, input) =>
      mutate(
        ctx,
        id,
        version,
        addPacketDecision(
          ctx.idempotencyKey === undefined ? ids('pkt') : derivedId('pkt', ctx),
          input,
        ),
      ),
    addDependency: (ctx, id, version, packetId, dependsOn) =>
      mutate(ctx, id, version, addDependencyDecision(packetId, dependsOn)),
    authorizePacket: (ctx, id, version, packetId, policyRefs) =>
      mutate(ctx, id, version, authorizePacketDecision(packetId, policyRefs)),
    verifyPacket: (ctx, id, version, packetId, evidenceRefs) =>
      mutate(ctx, id, version, verifyPacketDecision(packetId, evidenceRefs)),
    rejectPacket: (ctx, id, version, packetId, reason) =>
      mutate(ctx, id, version, rejectPacketDecision(packetId, reason)),
    requeuePacket: (ctx, id, version, packetId) =>
      mutate(ctx, id, version, requeuePacketDecision(packetId)),
    startAttempt: (ctx, id, version, attemptId) =>
      mutate(ctx, id, version, startAttemptDecision(attemptId)),
    reportAttempt: (ctx, id, version, attemptId, outcome, summary) =>
      mutate(
        ctx,
        id,
        version,
        reportAttemptDecision(attemptId, outcome, summary),
      ),

    getMission: (workspaceId, missionId) =>
      loadMission(db, workspaceId, missionId),

    search: (workspaceId, query) => searchMissions(db, workspaceId, query),

    activity(workspaceId, missionId, { afterVersion, limit }) {
      const events = loadEvents(workspaceId, missionId);
      const states = statesAfterEach(events);
      const page = events
        .filter((e) => e.version > afterVersion)
        .slice(0, limit);
      const last = page[page.length - 1];
      return {
        items: page.map((e) => ({
          version: e.version,
          seq: e.seq,
          type: e.type,
          actorId: e.actorId,
          correlationId: e.correlationId,
          policyRefs: e.policyRefs,
          evidenceRefs: e.evidenceRefs,
          recordedAt: e.recordedAt,
          payload: e.payload,
          stateAfter: states[e.version - 1] ?? 'draft',
        })),
        nextAfterVersion:
          last !== undefined && last.version < events.length
            ? last.version
            : null,
      };
    },

    replayMission: (workspaceId, missionId) =>
      replay(loadEvents(workspaceId, missionId)),

    rebuildProjection(workspaceId, missionId) {
      return inTransaction((tx, log) => {
        const events = log.readStream(workspaceId, missionStreamId(missionId));
        if (events.length === 0) {
          throw new MissionNotFoundError(missionId);
        }
        const mission = replay(events);
        writeProjection(tx, mission, events[0]?.seq ?? 0);
        return mission;
      });
    },

    schedulableMissionIds: (workspaceId, states) =>
      listSchedulableMissionIds(db, workspaceId, states),

    withMission(workspaceId, missionId, actor, fn) {
      const streamId = missionStreamId(missionId);
      return inTransaction((tx, log) => {
        const events = log.readStream(workspaceId, streamId);
        if (events.length === 0) {
          throw new MissionNotFoundError(missionId);
        }
        const seq = events[0]?.seq ?? 0;
        const session: MissionSession = {
          state: replay(events),
          step(decision, meta) {
            const { event } = log.append({
              workspaceId,
              streamId,
              expectedVersion: session.state.version,
              type: decision.type,
              payload: { ...decision.payload, at: meta.at },
              actorId: actor.id,
              correlationId: meta.correlationId,
              policyRefs: decision.policyRefs ?? [],
              evidenceRefs: decision.evidenceRefs ?? [],
            });
            decision.check(session.state, envFor(tx, actor, session.state));
            session.state = applyEvent(session.state, event);
            writeProjection(tx, session.state, seq);
            return event;
          },
        };
        return fn(session);
      });
    },
  };
}

function isCancel(decision: Decision): boolean {
  return (
    decision.type === 'mission.transitioned' &&
    (decision.payload as { to: string }).to === 'cancelled'
  );
}

function checkParent(
  tx: SqlDatabase,
  workspaceId: string,
  parentId: string,
): void {
  const parent = loadMission(tx, workspaceId, parentId);
  if (parent === undefined) {
    throw new ValidationError([
      { path: 'parentId', message: 'is not a mission in this workspace' },
    ]);
  }
  if (parent.state === 'cancelled') {
    throw new ValidationError([
      { path: 'parentId', message: 'is a cancelled mission' },
    ]);
  }
}
