import type { RunnerPool } from '../core/scheduler.js';
import type { WorkPacket } from '../core/types.js';
import type { SqlDatabase } from '../storage/database.js';
import type { FleetConfig } from './config.js';
import { requirementsOf, scopeAllowed } from './scope.js';
import {
  listRunners,
  liveLeaseCount,
  liveLeaseOnScope,
  type Runner,
  runnerLoad,
} from './store.js';
import { inSupportedRange } from './version.js';

export interface EligibilityOptions {
  /** Dispatch wants a runner heard from recently. A claim is itself proof of life. */
  requireLive: boolean;
  /**
   * What counts against `maxConcurrent`. Dispatch counts leases and attempts not yet claimed.
   * A claim counts leases only, because the attempt being claimed is not yet one of them.
   * `none` is for a lease the runner already holds.
   */
  load: 'dispatched' | 'leases' | 'none';
}

/**
 * Why a runner may not take this packet right now, or undefined when it may.
 * Evaluated from current rows every time, so a capability, quota, status or version change
 * takes effect on the next dispatch and the next claim with no separate refresh step.
 */
export function ineligibleReason(
  db: SqlDatabase,
  config: FleetConfig,
  runner: Runner,
  missionId: string,
  packet: Pick<WorkPacket, 'id' | 'scope'>,
  now: Date,
  options: EligibilityOptions,
): string | undefined {
  if (runner.status !== 'active') {
    return `runner is ${runner.status}`;
  }
  if (!inSupportedRange(runner.boundVersion, config.supportedVersions())) {
    return 'bound version is not supported';
  }
  if (options.requireLive) {
    const seen =
      runner.lastSeenAt === null ? Number.NaN : Date.parse(runner.lastSeenAt);
    if (Number.isNaN(seen) || now.getTime() - seen > config.livenessWindowMs) {
      return 'runner is not live';
    }
  }
  const need = requirementsOf(missionId, packet);
  if (need.invalid !== undefined) {
    return `execution scope is ambiguous: ${need.invalid}`;
  }
  const missing = need.capabilities.find(
    (cap) => !runner.capabilities.includes(cap),
  );
  if (missing !== undefined) {
    return `missing capability ${missing}`;
  }
  const outside = need.scopes.find(
    (entry) => !scopeAllowed(runner.allowedScopes, entry),
  );
  if (outside !== undefined) {
    return `scope ${outside} is not allowed`;
  }
  const load =
    options.load === 'none'
      ? 0
      : options.load === 'leases'
        ? liveLeaseCount(db, runner.workspaceId, runner.id)
        : runnerLoad(db, runner.workspaceId, runner.id);
  if (options.load !== 'none' && load >= runner.maxConcurrent) {
    return 'runner is at capacity';
  }
  return undefined;
}

export interface PickRequest {
  workspaceId: string;
  missionId: string;
  packet: Pick<WorkPacket, 'id' | 'scope'>;
  now: Date;
  exclude?: string | undefined;
  /** A live lease on the scope that the caller is about to replace, so it does not count as busy. */
  ignoreLease?: string | undefined;
}

/**
 * The best eligible runner: capability, allowed scope, load and liveness filter, then affinity
 * (the runner that last held this scope, then one that already worked on the mission), then the
 * lighter load, then id for a stable order. Undefined when none qualifies or the scope is busy.
 */
export function pickRunner(
  db: SqlDatabase,
  config: FleetConfig,
  request: PickRequest,
): Runner | undefined {
  const { workspaceId, missionId, packet, now } = request;
  const { scopeKey } = requirementsOf(missionId, packet);
  const held = liveLeaseOnScope(db, workspaceId, scopeKey);
  if (held !== undefined && held.id !== request.ignoreLease) {
    return undefined;
  }
  const lastOnScope = db.get<{ runner_id: string }>(
    'SELECT runner_id FROM runner_leases WHERE workspace_id = ? AND scope_key = ? ORDER BY fence DESC LIMIT 1',
    [workspaceId, scopeKey],
  )?.runner_id;
  const onMission = new Set(
    db
      .all<{ runner_id: string }>(
        'SELECT DISTINCT runner_id FROM runner_leases WHERE workspace_id = ? AND mission_id = ?',
        [workspaceId, missionId],
      )
      .map((row) => row.runner_id),
  );

  const ranked = listRunners(db, workspaceId, 'active')
    .filter((runner) => runner.id !== request.exclude)
    .filter(
      (runner) =>
        ineligibleReason(db, config, runner, missionId, packet, now, {
          requireLive: true,
          load: 'dispatched',
        }) === undefined,
    )
    .map((runner) => ({
      runner,
      affinity:
        runner.id === lastOnScope ? 2 : onMission.has(runner.id) ? 1 : 0,
      load: runnerLoad(db, workspaceId, runner.id),
    }))
    .sort(
      (a, b) =>
        b.affinity - a.affinity ||
        a.load - b.load ||
        (a.runner.id < b.runner.id ? -1 : a.runner.id > b.runner.id ? 1 : 0),
    );
  return ranked[0]?.runner;
}

/** The scheduler's view of the fleet. Reads only, so it is safe inside the scheduler's transaction. */
export function createFleetPool(deps: {
  db: SqlDatabase;
  config: FleetConfig;
  now: () => Date;
}): RunnerPool {
  return {
    findEligible({ workspaceId, mission, packet }) {
      const runner = pickRunner(deps.db, deps.config, {
        workspaceId,
        missionId: mission.id,
        packet,
        now: deps.now(),
      });
      return runner === undefined ? undefined : { runnerId: runner.id };
    },
  };
}
