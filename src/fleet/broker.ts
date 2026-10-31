import type { PrincipalKind } from '../auth/principals.js';
import type { RunnerPool } from '../core/scheduler.js';
import type { ActivityPage } from '../core/service.js';
import type { MissionState, WorkPacket } from '../core/types.js';
import { isHalted } from '../ops/halt.js';
import { refusalForPolicyRefs } from '../policy/packet-refs.js';
import { hasTraversal, matchesPattern } from '../policy/patterns.js';
import { createPolicyService } from '../policy/service.js';
import type { PolicyRule } from '../policy/types.js';
import type { SqlDatabase } from '../storage/database.js';
import type { FleetConfig } from './config.js';
import { redactString } from './redact.js';
import { canonicalEntry, requirementsOf, scopeAllowed } from './scope.js';
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
const CLAIM_DENIED_CODE = 'claim_authority_denied';

/**
 * Re-checks the authority a packet was authorized under, at the point of a claim, and returns why
 * it may not be claimed now, or `undefined` when it may.
 *
 * - A chief of staff's cited policy refs are re-validated, as at authorization: a revoked, expired,
 *   deny-covered or replaced rule refuses that packet only.
 * - A human's authorization is re-checked against deny rules only, and refuses if the human is
 *   disabled. A human's standing does not expire, but a deny rule added since authorization still
 *   withholds the branch.
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
  // Defense in depth for a packet stored before authorization required a scope: with none, no deny
  // rule or runner scope could be checked against it.
  if (packet.scope.length === 0) {
    return `authority: packet ${packet.id} declares no execution scope. Cancel it and add the packet again with a scope`;
  }
  const actor = db.get<{ kind: string; disabled_at: string | null }>(
    'SELECT kind, disabled_at FROM principals WHERE id = ? AND workspace_id = ?',
    [auth.by, workspaceId],
  );
  // A packet whose authorizer is no longer in the workspace has no standing to run.
  if (actor === undefined) {
    const who = redactString(auth.by).slice(0, 128);
    return `authority: the authorizing principal ${who} is not in this workspace`;
  }
  // A disabled authorizer has no standing, whatever kind it is and whether or not it cited a rule.
  if (actor.disabled_at !== null) {
    return 'authority: the principal is disabled';
  }
  if (actor.kind === 'human') {
    const denied = deniedClaim(db, clock, workspaceId, {
      id: auth.by,
      mission,
      packet,
    });
    return denied === undefined
      ? undefined
      : `authority: ${redactString(denied).slice(0, 280)}`;
  }
  const policy = createPolicyService({ db, clock });
  const cited = auth.policyRefs.filter((ref) => ref.startsWith('policy:'));
  if (cited.length === 0) {
    return undefined;
  }
  // Only a confirmed human is exempt from the cited refs. Anything else is re-checked.
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
 * Why a human's packet may not be claimed under current deny rules, or `undefined`. A deny rule
 * covers the claim when it names the grantee, the claim action, the mission, and one of the packet's
 * scopes. Its resource is not compared, since a packet names no resource to compare it with. This
 * mirrors the policy service's deny coverage on that basis. A missing allow rule is not a refusal,
 * since a human's authorization needs none. A scope the rules cannot check refuses, as an
 * unchecked scope would otherwise slip past every deny rule.
 */
function deniedClaim(
  db: SqlDatabase,
  clock: () => Date,
  workspaceId: string,
  authorizer: {
    id: string;
    mission: Pick<MissionState, 'id'>;
    packet: WorkPacket;
  },
): string | undefined {
  const { id, mission, packet } = authorizer;
  if (packet.scope.some((scope) => !checkableScope(scope))) {
    return `packet ${packet.id} declares a scope a deny rule cannot be checked against`;
  }
  const denies = createPolicyService({ db, clock })
    .listRules(workspaceId, { status: 'active' })
    .filter((rule) => denyApplies(rule, id, mission.id));
  for (const scope of packet.scope) {
    const rule = denies.find((candidate) =>
      coversScope(candidate.scope, scope),
    );
    if (rule !== undefined) {
      return `denied by rule ${rule.id} for scope ${scope}`;
    }
  }
  return undefined;
}

/**
 * Whether a deny rule's scope covers a packet scope. A literal or wildcard pattern matches by name.
 * A `repo:` or `worktree:` rule also covers any spelling of the same entry, so `repo:Foo` covers
 * `repo:foo`, as the fleet itself treats them as one scope.
 */
function coversScope(pattern: string, scope: string): boolean {
  if (matchesPattern(pattern, scope)) {
    return true;
  }
  const canonical = canonicalEntry(pattern);
  return canonical !== undefined && canonical === canonicalEntry(scope);
}

/** Whether an active deny rule names this claim's principal, action and mission, not its resource. */
function denyApplies(rule: PolicyRule, principalId: string, missionId: string) {
  const { grantee, limits } = rule;
  // A human's claim is only ever checked here, so a grantee of any kind but human does not apply.
  return (
    rule.effect === 'deny' &&
    (grantee.kind === null || grantee.kind === 'human') &&
    (grantee.principalId === null || grantee.principalId === principalId) &&
    matchesPattern(rule.action, CLAIM_ACTION) &&
    (limits.missionIds === null || limits.missionIds.includes(missionId))
  );
}

/**
 * A scope a deny rule can be matched against. The rules match literal names, so only a name in
 * printable lowercase ASCII, with no wildcard or traversal, can be checked. Any other spelling is
 * refused as uncheckable: spacing (the fleet reads `cap: docker` as `cap:docker`, which a literal
 * rule would not match), uppercase, homoglyphs, combining or invisible characters, and padding.
 */
const CHECKABLE_SCOPE = /^[\x21-\x7e]+$/;

function checkableScope(scope: string): boolean {
  return (
    CHECKABLE_SCOPE.test(scope) &&
    !/[A-Z]/.test(scope) &&
    !scope.includes('*') &&
    !hasTraversal(scope)
  );
}

/** The policy version now. Read inside the claim, so a refusal names the version it was decided under. */
export function policyVersionOf(
  db: SqlDatabase,
  clock: () => Date,
  workspaceId: string,
): number {
  return createPolicyService({ db, clock }).policyVersion(workspaceId);
}

/** A claim-time refusal, held until the claim settles so it is recorded whatever the outcome. */
export interface ClaimRefusal {
  attemptId: string;
  runnerId: string;
  authorizedBy: string;
  mission: Pick<MissionState, 'id' | 'risk'>;
  packet: Pick<WorkPacket, 'id' | 'scope'>;
  reason: string;
  /** The policy version the reason was decided under. */
  policyVersion: number;
}

/**
 * Writes a claim-time refusal: a `claim.authority_denied` audit row and a deny receipt, once per
 * attempt and policy version, so repeated polls under the same policy write nothing new. The receipt
 * needs the authorizing principal to exist, and is skipped when it does not; the audit row always
 * lands. Runs in its own transaction after the claim settles, so a claim that rolls back still
 * leaves its refusals on record.
 */
export function recordClaimRefusals(
  db: SqlDatabase,
  clock: () => Date,
  workspaceId: string,
  refusals: readonly ClaimRefusal[],
): void {
  for (const refusal of refusals) {
    recordClaimRefusal(db, clock, workspaceId, refusal);
  }
}

function recordClaimRefusal(
  db: SqlDatabase,
  clock: () => Date,
  workspaceId: string,
  refusal: ClaimRefusal,
): void {
  const at = clock().toISOString();
  const { policyVersion } = refusal;
  const seenAudit = db.get<{ n: number }>(CLAIM_REFUSAL_SEEN_SQL, [
    workspaceId,
    refusal.attemptId,
    policyVersion,
  ]);
  if ((seenAudit?.n ?? 0) === 0) {
    recordAudit(db, workspaceId, at, {
      kind: 'claim.authority_denied',
      runnerId: refusal.runnerId,
      actorId: refusal.authorizedBy,
      detail: {
        attemptId: refusal.attemptId,
        packetId: refusal.packet.id,
        missionId: refusal.mission.id,
        policyVersion,
        reason: refusal.reason,
      },
    });
  }
  const principal = db.get<{ id: string }>(
    'SELECT id FROM principals WHERE id = ? AND workspace_id = ?',
    [refusal.authorizedBy, workspaceId],
  );
  const resource = `attempt:${refusal.attemptId}`;
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
      refusal.authorizedBy,
      CLAIM_ACTION,
      resource,
      refusal.packet.scope.join(','),
      refusal.mission.risk,
      refusal.mission.id,
      CLAIM_DENIED_CODE,
      refusal.reason,
      policyVersion,
      at,
    ],
  );
}

/** Rule ids and policy refs name standing rules. Only a person or chief of staff is shown them. */
export function withoutRuleIds(text: string): string {
  return text
    .replace(/policy:v\d+:rule:[^\s@]+@\d+/g, 'a policy rule')
    .replace(/\brul_[A-Za-z0-9_-]+/g, 'a rule');
}

/** What replaces a policy ref in a mission shown to a runner or a provider. */
export const REDACTED_POLICY_REF = '[redacted]';

/**
 * A mission as one viewer may read it. A person or a chief of staff sees it whole. For a runner or
 * a provider, every policy ref (the mission's and each packet authorization's) is replaced by a
 * marker, since a ref names a standing rule by id. Nothing else changes.
 */
export function missionForViewer(
  mission: MissionState,
  viewer: PrincipalKind,
): MissionState {
  if (viewer === 'human' || viewer === 'chief_of_staff') {
    return mission;
  }
  const hide = (refs: readonly string[]): string[] =>
    refs.map(() => REDACTED_POLICY_REF);
  return {
    ...mission,
    policyRefs: hide(mission.policyRefs),
    packets: mission.packets.map((packet) =>
      packet.authorization === null
        ? packet
        : {
            ...packet,
            authorization: {
              ...packet.authorization,
              policyRefs: hide(packet.authorization.policyRefs),
            },
          },
    ),
  };
}

/** Rule-id-free copy of any JSON value: `policyRefs` keys are dropped and every string is cleaned. */
function withoutRuleIdsDeep(value: unknown): unknown {
  if (typeof value === 'string') {
    return withoutRuleIds(value);
  }
  if (Array.isArray(value)) {
    return value.map(withoutRuleIdsDeep);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'policyRefs')
        .map(([key, item]) => [key, withoutRuleIdsDeep(item)]),
    );
  }
  return value;
}

/**
 * A mission's activity as one viewer may read it. A person or a chief of staff sees it whole. For
 * a runner or a provider, each item loses its `policyRefs`, any `policyRefs` inside its payload
 * (`mission.created` carries them), and every rule id or policy ref written in a string.
 */
export function activityForViewer(
  page: ActivityPage,
  viewer: PrincipalKind,
): ActivityPage {
  if (viewer === 'human' || viewer === 'chief_of_staff') {
    return page;
  }
  return withoutRuleIdsDeep(page) as ActivityPage;
}

/**
 * The two audit lookups a claim poll makes. Their WHERE clauses repeat the expression and the
 * `kind` literal of the partial indexes `fleet_audit_claim_attempt_idx` and
 * `fleet_audit_claim_mission_idx` (migration 0009), so they search those indexes and never scan the
 * workspace's audit. A change here must change the index, and the plan test fails if it does not.
 */
export const CLAIM_REFUSAL_SEEN_SQL = `SELECT COUNT(*) AS n FROM fleet_audit
      WHERE workspace_id = ? AND kind = 'claim.authority_denied'
        AND json_extract(detail_json, '$.attemptId') = ?
        AND json_extract(detail_json, '$.policyVersion') = ?`;

export const AUTHORITY_HOLDS_SQL = `SELECT json_extract(f.detail_json, '$.attemptId') AS attempt_id,
            json_extract(f.detail_json, '$.packetId') AS packet_id,
            f.at AS at
       FROM fleet_audit f
       JOIN execution_attempts a
         ON a.workspace_id = f.workspace_id
        AND a.id = json_extract(f.detail_json, '$.attemptId')
      WHERE f.workspace_id = ? AND f.kind = 'claim.authority_denied'
        AND json_extract(f.detail_json, '$.missionId') = ?
        AND a.status IN ('leased', 'running')
        AND NOT EXISTS (
          SELECT 1 FROM runner_leases l
           WHERE l.workspace_id = a.workspace_id AND l.attempt_id = a.id
             AND l.confirmed_at IS NOT NULL)
      ORDER BY f.seq`;

/** A refusal still standing on an offer a runner has not yet been granted, for the API. */
export interface AuthorityHold {
  attemptId: string;
  packetId: string;
  reason: string;
  policyVersion: number;
  /** When the refusal was last recorded. */
  at: string;
}

/**
 * The holds on a mission's work: each attempt refused at a claim that is still refused now and has no
 * lease the runner has confirmed, with the reason it is refused now. Read-only. Confirmed work keeps
 * running, so it is not held. An attempt that ended is not held, and neither is one whose authority
 * has since been restored.
 */
export function authorityHoldsFor(
  db: SqlDatabase,
  clock: () => Date,
  workspaceId: string,
  mission: MissionState,
  /**
   * Who is reading. Rule ids are shown to a person or a chief of staff only: for a runner or a
   * provider they are removed.
   */
  viewer: PrincipalKind,
): AuthorityHold[] {
  const seesRules = viewer === 'human' || viewer === 'chief_of_staff';
  const refused = db.all<{
    attempt_id: string;
    packet_id: string;
    at: string;
  }>(AUTHORITY_HOLDS_SQL, [workspaceId, mission.id]);
  const latest = new Map<string, { packet_id: string; at: string }>();
  for (const row of refused) {
    latest.set(row.attempt_id, { packet_id: row.packet_id, at: row.at });
  }
  const policyVersion = createPolicyService({ db, clock }).policyVersion(
    workspaceId,
  );
  const holds: AuthorityHold[] = [];
  for (const [attemptId, { packet_id, at }] of latest) {
    const packet = mission.packets.find((p) => p.id === packet_id);
    if (packet === undefined) {
      continue;
    }
    const reason = authorityReason(db, clock, workspaceId, mission, packet);
    if (reason !== undefined) {
      holds.push({
        attemptId,
        packetId: packet_id,
        reason: seesRules ? reason : withoutRuleIds(reason),
        policyVersion,
        at,
      });
    }
  }
  return holds;
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
      // An emergency halt dispatches nothing new. Work waits as it is, and resumes with the halt lifted.
      if (isHalted(deps.db, workspaceId)) {
        return undefined;
      }
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
