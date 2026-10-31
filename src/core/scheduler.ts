import { newId } from '../shared/ids.js';
import {
  type Decision,
  dispatchAttemptDecision,
  readyPacketDecision,
  requireWriter,
  transitionDecision,
} from './commands.js';
import { dependenciesSatisfied } from './dependency-graph.js';
import type { MissionService } from './service.js';
import { canTransitionMission } from './transitions.js';
import type {
  Actor,
  MissionState,
  MissionStatus,
  WorkPacket,
} from './types.js';

/**
 * The runner fleet as the scheduler sees it. The real fleet arrives with the runner
 * protocol; until a pool is wired in, no runner exists and authorized work waits.
 */
export interface RunnerPool {
  /** An online runner that can take this packet right now, or undefined. */
  findEligible(request: {
    workspaceId: string;
    mission: MissionState;
    packet: WorkPacket;
  }): { runnerId: string } | undefined;
}

export const NO_RUNNERS: RunnerPool = { findEligible: () => undefined };

/** Mission states in which the scheduler may dispatch work and move the mission along. */
export const SCHEDULED_STATES: readonly MissionStatus[] = [
  'ready',
  'running',
  'waiting-runner',
  'waiting-decision',
];

export interface TickChange {
  missionId: string;
  from: MissionStatus;
  to: MissionStatus;
  /** Event types appended, in order. */
  events: string[];
}

export interface TickResult {
  /** The injected clock's reading for this tick. */
  at: string;
  /** Only missions that changed. A second tick over the same state returns none. */
  changes: TickChange[];
}

export interface Scheduler {
  /** Advances every schedulable mission in the workspace as far as it can go without outside input. */
  tick(workspaceId: string, actor: Actor, correlationId?: string): TickResult;
}

export interface SchedulerDeps {
  service: MissionService;
  pool?: RunnerPool;
  clock?: () => Date;
  newId?: (prefix: string) => string;
}

/**
 * The state a mission should be in given its packets, or undefined to leave it alone.
 * Work in flight beats work waiting for a runner, which beats work waiting for a decision.
 * A blocked packet changes nothing for packets on other branches: only the mission-level
 * summary below looks across them, and only once nothing else can move.
 */
export function deriveMissionState(
  mission: MissionState,
): MissionStatus | undefined {
  const live = mission.packets.filter((p) => p.status !== 'cancelled');
  if (live.length === 0) {
    return undefined;
  }
  if (
    live.some(
      (p) =>
        p.status === 'leased' ||
        p.status === 'running' ||
        p.status === 'reported',
    )
  ) {
    return 'running';
  }
  if (live.some((p) => p.status === 'ready')) {
    // Authorized work exists and no runner took it. Waiting, not failed.
    return 'waiting-runner';
  }
  const required = live.filter((p) => p.required);
  const goal = required.length > 0 ? required : live;
  if (goal.every((p) => p.status === 'verified')) {
    return 'verifying';
  }
  const awaitingDecision = live.some(
    (p) =>
      p.status === 'pending' &&
      p.authorization === null &&
      dependenciesSatisfied(p, mission.packets),
  );
  return awaitingDecision ? 'waiting-decision' : 'needs-attention';
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const { service } = deps;
  const pool = deps.pool ?? NO_RUNNERS;
  const clock = deps.clock ?? (() => new Date());
  const ids = deps.newId ?? newId;

  return {
    tick(workspaceId, actor, correlationId) {
      requireWriter(actor, 'run the scheduler');
      const at = clock().toISOString();
      const correlation = correlationId ?? ids('cor');
      const changes: TickChange[] = [];

      for (const missionId of service.schedulableMissionIds(
        workspaceId,
        SCHEDULED_STATES,
      )) {
        const change = service.withMission(
          workspaceId,
          missionId,
          actor,
          (session) => {
            const from = session.state.state;
            const events: string[] = [];
            const append = (decision: Decision) => {
              events.push(
                session.step(decision, { correlationId: correlation, at }).type,
              );
            };

            // Packets whose prerequisites are all verified and that carry an authorization.
            for (const packet of [...session.state.packets]) {
              const current = session.state.packets.find(
                (p) => p.id === packet.id,
              );
              if (
                current?.status === 'pending' &&
                current.authorization !== null &&
                dependenciesSatisfied(current, session.state.packets)
              ) {
                append(readyPacketDecision(current.id));
              }
            }

            for (const packet of [...session.state.packets]) {
              if (packet.status !== 'ready') {
                continue;
              }
              const runner = pool.findEligible({
                workspaceId,
                mission: session.state,
                packet:
                  session.state.packets.find((p) => p.id === packet.id) ??
                  packet,
              });
              if (runner !== undefined) {
                append(
                  dispatchAttemptDecision(
                    ids('att'),
                    packet.id,
                    runner.runnerId,
                  ),
                );
              }
            }

            const target = deriveMissionState(session.state);
            if (
              target !== undefined &&
              target !== session.state.state &&
              canTransitionMission(session.state.state, target)
            ) {
              append(transitionDecision(target, 'scheduler'));
            }
            return events.length === 0
              ? undefined
              : { missionId, from, to: session.state.state, events };
          },
        );
        if (change !== undefined) {
          changes.push(change);
        }
      }
      return { at, changes };
    },
  };
}
