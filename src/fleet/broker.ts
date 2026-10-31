import type { RunnerPool } from '../core/scheduler.js';
import type { MissionState, WorkPacket } from '../core/types.js';
import { refusalForPolicyRefs } from '../policy/packet-refs.js';
import { hasTraversal } from '../policy/patterns.js';
import { createPolicyService, type PolicyService } from '../policy/service.js';
import type { SqlDatabase } from '../storage/database.js';
import type { FleetConfig } from './config.js';
import { redactString } from './redact.js';
import { requirementsOf, scopeAllowed } from './scope.js';
import {
  listRunners,
  liveLeaseCount,
  liveLeaseOnScope,
  type Runner,
  recordAudit,
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
  ...args: Parameters<typeof reasonFor>
): string | undefined {
  const reason = reasonFor(...args);
  // The reason can echo an entry a packet author wrote, and it is sent to the runner.
  return reason === undefined ? undefined : redactString(reason).slice(0, 300);
}

/**
 * The action a packet's claim is checked as. A packet names no action of its own, so a deny rule
 * covers a claim when it names this action (or a wildcard that matches it), its packet's scope,
 * and the mission.
 */
const CLAIM_ACTION = 'packet.claim';

/**
 * Re-checks the authority a packet was authorized under, at the point of a claim, and returns why
 * it may not be claimed now, or `undefined` when it may.
 *
 * - A chief of staff's cited policy refs are re-validated, as at authorization: a revoked, expired,
 *   deny-covered or replaced rule refuses that packet only.
 * - A human's authorization is re-checked against deny rules only. A human's standing does not
 *   expire, but a deny rule added since authorization still withholds the branch.
 *
 * The principal evaluated is the one that authorized the packet (`authorization.by`), not the
 * runner: the runner's own scope, capability and quota are checked by `ineligibleReason`, and the
 * authority to run the packet is the authorizer's.
 */
export function authorityReason(
  db: SqlDatabase,
  clock: () => Date,
  workspaceId: string,
  mission: Pick<MissionState, 'id' | 'risk'>,
  packet: WorkPacket,
): string | undefined {
  const auth = packet.authorization;
  if (auth === null) {
    return undefined;
  }
  const actor = db.get<{ kind: string }>(
    'SELECT kind FROM principals WHERE id = ? AND workspace_id = ?',
    [auth.by, workspaceId],
  );
  const policy = createPolicyService({ db, clock });
  if (actor?.kind === 'human') {
    const denied = deniedClaim(policy, workspaceId, auth.by, mission, packet);
    return denied === undefined
      ? undefined
      : `authority: ${redactString(denied).slice(0, 280)}`;
  }
  const cited = auth.policyRefs.filter((ref) => ref.startsWith('policy:'));
  if (cited.length === 0) {
    return undefined;
  }
  // Only a confirmed human is exempt from the cited refs. Anything else, including a principal row
  // that is missing, is re-checked, and an unknown principal is denied by the policy service.
  const refusal = refusalForPolicyRefs(
    policy,
    { workspaceId, actor: { id: auth.by }, mission, packet },
    cited,
  );
  return refusal === undefined
    ? undefined
    : `authority: ${redactString(refusal).slice(0, 280)}`;
}

/**
 * Why a human's packet may not be claimed under current deny rules, or `undefined`. Only an
 * explicit deny refuses: the absence of an allow rule is not a refusal here, since a human's
 * authorization needs no rule. A packet with no scope is checked under its own name, so a deny rule
 * with a wildcard scope still covers it. A scope the policy service cannot check refuses, as an
 * unchecked scope would otherwise slip past every deny rule.
 */
function deniedClaim(
  policy: PolicyService,
  workspaceId: string,
  authorizedBy: string,
  mission: Pick<MissionState, 'id' | 'risk'>,
  packet: WorkPacket,
): string | undefined {
  if (
    packet.scope.some((scope) => scope.includes('*') || hasTraversal(scope))
  ) {
    return `packet ${packet.id} declares a scope a deny rule cannot be checked against`;
  }
  const scopes =
    packet.scope.length === 0 ? [`packet:${packet.id}`] : packet.scope;
  for (const scope of scopes) {
    const evaluation = policy.authorize({
      workspace: workspaceId,
      principal: authorizedBy,
      action: CLAIM_ACTION,
      resource: `packet:${packet.id}`,
      scope,
      risk: mission.risk,
      missionId: mission.id,
    });
    if (evaluation.code === 'explicit_deny') {
      return evaluation.reason;
    }
  }
  return undefined;
}

const CLAIM_DENIED_CODE = 'claim_authority_denied';

/**
 * Records a claim-time authority refusal: a `claim.authority_denied` audit row and a deny receipt,
 * once per attempt and policy version, so repeated polls under the same policy write nothing new.
 * The receipt needs the authorizing principal to exist, and is skipped when it does not; the audit
 * row always lands. Called inside the claim's transaction, which commits because a refusal is a
 * held offer and not an error.
 */
export function recordClaimDenial(
  db: SqlDatabase,
  clock: () => Date,
  workspaceId: string,
  claim: {
    attemptId: string;
    runnerId: string;
    authorizedBy: string;
    mission: Pick<MissionState, 'id' | 'risk'>;
    packet: Pick<WorkPacket, 'id' | 'scope'>;
    reason: string;
  },
): void {
  const at = clock().toISOString();
  const policyVersion = createPolicyService({ db, clock }).policyVersion(
    workspaceId,
  );
  const seenAudit = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM fleet_audit
      WHERE workspace_id = ? AND kind = 'claim.authority_denied'
        AND json_extract(detail_json, '$.attemptId') = ?
        AND json_extract(detail_json, '$.policyVersion') = ?`,
    [workspaceId, claim.attemptId, policyVersion],
  );
  if ((seenAudit?.n ?? 0) === 0) {
    recordAudit(db, workspaceId, at, {
      kind: 'claim.authority_denied',
      runnerId: claim.runnerId,
      actorId: claim.authorizedBy,
      detail: {
        attemptId: claim.attemptId,
        packetId: claim.packet.id,
        missionId: claim.mission.id,
        policyVersion,
        reason: claim.reason,
      },
    });
  }
  const principal = db.get<{ id: string }>(
    'SELECT id FROM principals WHERE id = ? AND workspace_id = ?',
    [claim.authorizedBy, workspaceId],
  );
  const resource = `attempt:${claim.attemptId}`;
  const seenReceipt = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM policy_receipts
      WHERE workspace_id = ? AND resource = ? AND policy_version = ? AND code = ?`,
    [workspaceId, resource, policyVersion, CLAIM_DENIED_CODE],
  );
  if (principal === undefined || (seenReceipt?.n ?? 0) > 0) {
    return;
  }
  db.run(
    `INSERT INTO policy_receipts (workspace_id, principal_id, action, resource, scope, risk, mission_id,
       effect, code, reason, rule_id, rule_version, policy_version, evaluated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'deny', ?, ?, NULL, NULL, ?, ?)`,
    [
      workspaceId,
      claim.authorizedBy,
      CLAIM_ACTION,
      resource,
      claim.packet.scope.join(','),
      claim.mission.risk,
      claim.mission.id,
      CLAIM_DENIED_CODE,
      claim.reason,
      policyVersion,
      at,
    ],
  );
}

/** The latest open claim-time refusal per attempt for a mission, for the API. */
export interface AuthorityHold {
  attemptId: string;
  packetId: string;
  reason: string;
  policyVersion: number;
  at: string;
}

/**
 * The claim-time refusals still standing for a mission: the latest per attempt, for attempts that
 * have not ended and have not been granted a lease since the refusal.
 */
export function authorityHoldsFor(
  db: SqlDatabase,
  workspaceId: string,
  missionId: string,
): AuthorityHold[] {
  const rows = db.all<{
    attempt_id: string;
    packet_id: string;
    reason: string;
    policy_version: number;
    at: string;
  }>(
    `SELECT json_extract(f.detail_json, '$.attemptId') AS attempt_id,
            json_extract(f.detail_json, '$.packetId') AS packet_id,
            json_extract(f.detail_json, '$.reason') AS reason,
            json_extract(f.detail_json, '$.policyVersion') AS policy_version,
            f.at AS at
       FROM fleet_audit f
       JOIN execution_attempts a
         ON a.workspace_id = f.workspace_id
        AND a.id = json_extract(f.detail_json, '$.attemptId')
      WHERE f.workspace_id = ? AND f.kind = 'claim.authority_denied'
        AND json_extract(f.detail_json, '$.missionId') = ?
        AND a.status IN ('leased', 'running')
        AND NOT EXISTS (
          SELECT 1 FROM fleet_audit g
           WHERE g.workspace_id = f.workspace_id AND g.kind = 'lease.granted'
             AND g.seq > f.seq
             AND json_extract(g.detail_json, '$.attemptId') = a.id)
      ORDER BY f.seq`,
    [workspaceId, missionId],
  );
  const latest = new Map<string, AuthorityHold>();
  for (const row of rows) {
    latest.set(row.attempt_id, {
      attemptId: row.attempt_id,
      packetId: row.packet_id,
      reason: row.reason,
      policyVersion: row.policy_version,
      at: row.at,
    });
  }
  return [...latest.values()];
}

function reasonFor(
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
