import { createHash } from 'node:crypto';
import { CoreError } from '../core/errors.js';
import { createMissionService } from '../core/service.js';
import type {
  Actor,
  ExecutionAttempt,
  MissionState,
  WorkPacket,
} from '../core/types.js';
import type { SqlDatabase } from '../storage/database.js';
import { backoffMs } from './backoff.js';
import { ineligibleReason, pickRunner } from './broker.js';
import { type FleetContext, savepoint } from './context.js';
import { FleetError } from './errors.js';
import type {
  Binding,
  CheckpointInput,
  Evidence,
  PollInput,
  ProgressInput,
  ReceiptInput,
  ReconcileInput,
} from './inputs.js';
import { redactString, redactValue } from './redact.js';
import { requirementsOf } from './scope.js';
import {
  getLease,
  getRunner,
  type Lease,
  liveLeaseOnScope,
  liveLeases,
  liveLeasesOf,
  nextFence,
  type Runner,
  recordAudit,
} from './store.js';
import { inSupportedRange } from './version.js';

export interface RunnerCaller {
  workspaceId: string;
  principalId: string;
  tokenId: string;
}

export interface Directives {
  cancel: boolean;
  pause: boolean;
}

export interface LeaseView {
  leaseId: string;
  attemptId: string;
  scopeKey: string;
  fence: number;
  status: Lease['status'];
  expiresAt: string;
  progressSeq: number;
  directives: Directives;
}

export interface Assignment extends LeaseView {
  missionId: string;
  packetId: string;
  ttlMs: number;
  packet: { title: string; instructions: string; scope: string[] };
  mission: {
    title: string;
    intent: string;
    outcome: string;
    constraints: string[];
  };
  /** Present when the lease continues earlier work: where to pick it up. */
  resume: {
    progressSeq: number;
    checkpoint: { ref: string; commit: string | null } | null;
  } | null;
}

export interface HeartbeatResult {
  runner: { id: string; status: Runner['status'] };
  /** Leases whose evidence matched Tower's record. Only these were renewed. */
  leases: LeaseView[];
  /** Evidence that matched nothing. It earned no renewal and counts as no work proof. */
  unmatched: Array<{ leaseId: string; reason: string; cancel: boolean }>;
  /** Leases in recovery that this runner must reconcile before it gets new work. */
  reconcile: LeaseView[];
}

export interface ClaimResult extends HeartbeatResult {
  assignments: Assignment[];
  withheld: Array<{ attemptId: string; reason: string }>;
  retryAfterMs: number;
}

const PAUSING_MISSION_STATES: readonly string[] = [
  'waiting-external',
  'needs-attention',
];

/** A joined handle so a core command shares the fleet's transaction instead of opening its own. */
function joined(tx: SqlDatabase): SqlDatabase {
  const handle: SqlDatabase = { ...tx, transaction: (fn) => fn(handle) };
  return handle;
}

function missionsIn(ctx: FleetContext, tx: SqlDatabase) {
  return createMissionService({
    db: joined(tx),
    guards: ctx.core.guards,
    newId: ctx.ids,
  });
}

/**
 * The principal the fleet acts as when the scheduler ticks or a reassigned runner's report is
 * relayed. It is a disabled principal of an existing kind: no token can ever be issued for it, so
 * it is an actor id on events and nothing else.
 */
export function systemActor(
  db: SqlDatabase,
  workspaceId: string,
  at: string,
): Actor {
  const id = `prn_fleet_${workspaceId}`;
  db.run(
    `INSERT OR IGNORE INTO principals (id, workspace_id, kind, name, disabled_at, created_at)
     VALUES (?, ?, 'chief_of_staff', 'tower-fleet', ?, ?)`,
    [id, workspaceId, at, at],
  );
  return { id, kind: 'chief_of_staff' };
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function sha(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

// ---------------------------------------------------------------- admission

/**
 * The runner behind a verified credential, once it is in good standing. `binding` is what the
 * runner reports about itself on a claim; it must equal what was attested at enrollment.
 */
function admit(
  ctx: FleetContext,
  tx: SqlDatabase,
  caller: RunnerCaller,
  binding?: Binding,
): Runner {
  const runner = getRunner(tx, caller.workspaceId, caller.principalId);
  if (runner === undefined) {
    throw new FleetError(
      'runner_required',
      'The caller is not an enrolled runner',
    );
  }
  const refuse = (
    code: ConstructorParameters<typeof FleetError>[0],
    message: string,
    reason: string,
    detail: Record<string, unknown> = {},
  ) =>
    new FleetError(code, message, {
      kind: 'runner.rejected',
      runnerId: runner.id,
      detail: { reason, ...detail },
    });
  if (runner.tokenId !== caller.tokenId) {
    throw refuse(
      'credential_not_bound',
      'This credential is not the one bound to the runner',
      'credential not bound',
      { tokenId: caller.tokenId },
    );
  }
  if (runner.status === 'quarantined') {
    throw refuse(
      'runner_quarantined',
      'The runner is quarantined',
      'quarantined',
    );
  }
  if (
    binding !== undefined &&
    (binding.version !== runner.boundVersion ||
      binding.buildDigest !== runner.boundDigest)
  ) {
    throw refuse(
      'version_mismatch',
      'The runner reports a version or digest other than the one it was enrolled with',
      'reported version or digest differs from the bound one',
      {
        reportedVersion: binding.version,
        reportedDigest: binding.buildDigest,
        boundVersion: runner.boundVersion,
        boundDigest: runner.boundDigest,
      },
    );
  }
  if (!inSupportedRange(runner.boundVersion, ctx.config.supportedVersions())) {
    throw refuse(
      'version_unsupported',
      'The version this runner is bound to is no longer supported; enroll a new runner',
      'bound version outside the supported range',
      { boundVersion: runner.boundVersion },
    );
  }
  return runner;
}

/** Records that the runner was heard from, and any change in the capabilities it declares. */
function touch(
  ctx: FleetContext,
  tx: SqlDatabase,
  runner: Runner,
  capabilities: string[] | undefined,
): Runner {
  const at = ctx.now().toISOString();
  const changed =
    capabilities !== undefined &&
    JSON.stringify([...capabilities].sort()) !==
      JSON.stringify([...runner.capabilities].sort());
  tx.run(
    'UPDATE runners SET last_seen_at = ?, updated_at = ?, capabilities_json = ? WHERE workspace_id = ? AND id = ?',
    [
      at,
      at,
      JSON.stringify(changed ? capabilities : runner.capabilities),
      runner.workspaceId,
      runner.id,
    ],
  );
  if (changed) {
    recordAudit(tx, runner.workspaceId, at, {
      kind: 'runner.capabilities_changed',
      runnerId: runner.id,
      detail: { from: runner.capabilities, to: capabilities },
    });
  }
  return {
    ...runner,
    lastSeenAt: at,
    capabilities: changed ? (capabilities ?? []) : runner.capabilities,
  };
}

// ----------------------------------------------------------- core projection

function attemptStatus(
  tx: SqlDatabase,
  workspaceId: string,
  attemptId: string,
): string | undefined {
  return tx.get<{ status: string }>(
    'SELECT status FROM execution_attempts WHERE workspace_id = ? AND id = ?',
    [workspaceId, attemptId],
  )?.status;
}

function missionStateOf(
  tx: SqlDatabase,
  workspaceId: string,
  missionId: string,
): string | undefined {
  return tx.get<{ state: string }>(
    'SELECT state FROM missions WHERE workspace_id = ? AND id = ?',
    [workspaceId, missionId],
  )?.state;
}

function directivesFor(
  tx: SqlDatabase,
  lease: Lease,
  runner: Runner | undefined,
): Directives {
  const attempt = attemptStatus(tx, lease.workspaceId, lease.attemptId);
  const mission = missionStateOf(tx, lease.workspaceId, lease.missionId);
  return {
    cancel:
      lease.status === 'cancelled' ||
      attempt === 'cancelled' ||
      mission === 'cancelled',
    pause:
      runner?.status === 'paused' ||
      (mission !== undefined && PAUSING_MISSION_STATES.includes(mission)),
  };
}

function viewOf(
  tx: SqlDatabase,
  lease: Lease,
  runner: Runner | undefined,
): LeaseView {
  return {
    leaseId: lease.id,
    attemptId: lease.attemptId,
    scopeKey: lease.scopeKey,
    fence: lease.fence,
    status: lease.status,
    expiresAt: lease.expiresAt,
    progressSeq: lease.progressSeq,
    directives: directivesFor(tx, lease, runner),
  };
}

function findPacket(
  mission: MissionState,
  lease: Pick<Lease, 'packetId' | 'attemptId'>,
): { packet: WorkPacket; attempt: ExecutionAttempt } | undefined {
  const packet = mission.packets.find((p) => p.id === lease.packetId);
  const attempt = mission.attempts.find((a) => a.id === lease.attemptId);
  return packet === undefined || attempt === undefined
    ? undefined
    : { packet, attempt };
}

function latestCheckpoint(
  tx: SqlDatabase,
  workspaceId: string,
  attemptId: string,
): { ref: string; commit: string | null } | undefined {
  const row = tx.get<{ ref: string; commit_sha: string | null }>(
    'SELECT ref, commit_sha FROM runner_checkpoints WHERE workspace_id = ? AND attempt_id = ? ORDER BY recorded_at DESC, rowid DESC LIMIT 1',
    [workspaceId, attemptId],
  );
  return row === undefined
    ? undefined
    : { ref: row.ref, commit: row.commit_sha };
}

function closeLease(
  ctx: FleetContext,
  tx: SqlDatabase,
  lease: Lease,
  status: 'completed' | 'fenced' | 'cancelled' | 'released',
  reason: string,
  actorId?: string,
): void {
  const at = ctx.now().toISOString();
  tx.run(
    'UPDATE runner_leases SET status = ?, closed_at = ?, close_reason = ? WHERE workspace_id = ? AND id = ?',
    [status, at, reason, lease.workspaceId, lease.id],
  );
  recordAudit(tx, lease.workspaceId, at, {
    kind: `lease.${status}`,
    runnerId: lease.runnerId,
    leaseId: lease.id,
    actorId: actorId ?? null,
    detail: { reason, fence: lease.fence, scopeKey: lease.scopeKey },
  });
}

function startRecovery(
  ctx: FleetContext,
  tx: SqlDatabase,
  lease: Lease,
  since: string,
  reason: string,
): void {
  tx.run(
    "UPDATE runner_leases SET status = 'recovering', recovering_since = ? WHERE workspace_id = ? AND id = ? AND status = 'held'",
    [since, lease.workspaceId, lease.id],
  );
  recordAudit(tx, lease.workspaceId, ctx.now().toISOString(), {
    kind: 'lease.recovering',
    runnerId: lease.runnerId,
    leaseId: lease.id,
    detail: { reason, fence: lease.fence },
  });
}

// --------------------------------------------------------------------- sweep

/**
 * Brings lease state up to date with the clock and with the mission. Runs at the start of every
 * fleet operation, so no operation sees a stale lease.
 *  1. A lease whose attempt was cancelled or already reported elsewhere is closed, freeing its scope.
 *  2. A held lease past its expiry, or held by a quarantined runner, moves to recovery. Never to failed.
 *  3. A lease in recovery past the grace period moves to another runner, but only from a recorded
 *     checkpoint, and only by fencing the old lease. Without a checkpoint the work waits.
 */
export function sweep(
  ctx: FleetContext,
  tx: SqlDatabase,
  workspaceId: string,
): void {
  const nowMs = ctx.now().getTime();
  const nowIso = iso(nowMs);
  for (const lease of liveLeases(tx, workspaceId)) {
    const attempt = attemptStatus(tx, workspaceId, lease.attemptId);
    if (attempt === 'cancelled') {
      closeLease(ctx, tx, lease, 'cancelled', 'the attempt was cancelled');
      continue;
    }
    if (attempt?.startsWith('self-reported') === true) {
      closeLease(
        ctx,
        tx,
        lease,
        'completed',
        'the attempt was already reported',
      );
      continue;
    }
    if (lease.status !== 'held') {
      continue;
    }
    if (getRunner(tx, workspaceId, lease.runnerId)?.status === 'quarantined') {
      startRecovery(ctx, tx, lease, nowIso, 'runner quarantined');
    } else if (Date.parse(lease.expiresAt) <= nowMs) {
      startRecovery(ctx, tx, lease, lease.expiresAt, 'missed heartbeats');
    }
  }
  for (const lease of liveLeases(tx, workspaceId)) {
    if (lease.status === 'recovering') {
      reassign(ctx, tx, lease, nowMs);
    }
  }
}

function reassign(
  ctx: FleetContext,
  tx: SqlDatabase,
  old: Lease,
  nowMs: number,
): void {
  const since = Date.parse(old.recoveringSince ?? old.expiresAt);
  if (since + ctx.config.reassignGraceMs > nowMs) {
    return;
  }
  if (
    old.reassignNotBefore !== null &&
    Date.parse(old.reassignNotBefore) > nowMs
  ) {
    return;
  }
  const holder = getRunner(tx, old.workspaceId, old.runnerId);
  if (holder?.status === 'quarantined') {
    // A quarantined runner's checkpoint is its own word. A human decides what happens to its work.
    return;
  }
  const checkpoint = latestCheckpoint(tx, old.workspaceId, old.attemptId);
  if (checkpoint === undefined) {
    return;
  }
  const mission = missionsIn(ctx, tx).getMission(
    old.workspaceId,
    old.missionId,
  );
  const found = mission === undefined ? undefined : findPacket(mission, old);
  if (found === undefined || directivesFor(tx, old, holder).pause) {
    return;
  }
  const at = iso(nowMs);
  const next = pickRunner(tx, ctx.config, {
    workspaceId: old.workspaceId,
    missionId: old.missionId,
    packet: found.packet,
    now: new Date(nowMs),
    exclude: old.runnerId,
    ignoreLease: old.id,
  });
  if (next === undefined) {
    const failures = old.reassignFailures + 1;
    tx.run(
      'UPDATE runner_leases SET reassign_failures = ?, reassign_not_before = ? WHERE workspace_id = ? AND id = ?',
      [
        failures,
        iso(nowMs + backoffMs(failures, ctx.config.backoff)),
        old.workspaceId,
        old.id,
      ],
    );
    return;
  }
  // Fence first: the old lease must be closed before the new one can take the scope.
  closeLease(ctx, tx, old, 'fenced', 'reassigned to another runner');
  const id = ctx.ids('lse');
  tx.run(
    `INSERT INTO runner_leases (workspace_id, id, scope_key, fence, attempt_id, mission_id, packet_id, runner_id,
       status, granted_at, expires_at, last_proof_at, progress_seq)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'held', ?, ?, ?, ?)`,
    [
      old.workspaceId,
      id,
      old.scopeKey,
      nextFence(tx, old.workspaceId, old.scopeKey),
      old.attemptId,
      old.missionId,
      old.packetId,
      next.id,
      at,
      iso(nowMs + ctx.config.leaseTtlMs),
      at,
      old.progressSeq,
    ],
  );
  recordAudit(tx, old.workspaceId, at, {
    kind: 'lease.reassigned',
    runnerId: next.id,
    leaseId: id,
    detail: {
      from: old.runnerId,
      fromLease: old.id,
      to: next.id,
      checkpoint: checkpoint.ref,
      commit: checkpoint.commit,
    },
  });
}

// ------------------------------------------------------------------ evidence

/**
 * Heartbeat evidence counts only when it names a lease this runner holds right now: the lease
 * id, attempt id and fencing token all match Tower's record, and it claims no progress Tower has
 * not stored. Anything else renews nothing and is audited. A runner that is alive but cannot
 * show matching evidence still loses its lease when the TTL runs out.
 */
function applyEvidence(
  ctx: FleetContext,
  tx: SqlDatabase,
  runner: Runner,
  items: readonly Evidence[],
): Pick<HeartbeatResult, 'leases' | 'unmatched'> {
  const now = ctx.now();
  const leases: LeaseView[] = [];
  const unmatched: HeartbeatResult['unmatched'] = [];
  for (const item of items) {
    const lease = getLease(tx, runner.workspaceId, item.leaseId);
    const owned = lease !== undefined && lease.runnerId === runner.id;
    let reason: string | undefined;
    if (!owned) {
      reason = 'unknown lease';
    } else if (lease.attemptId !== item.attemptId) {
      reason = 'attempt does not match the lease';
    } else if (lease.status === 'recovering') {
      continue; // listed under `reconcile`, and earns no renewal
    } else if (lease.status !== 'held') {
      reason = `lease is ${lease.status}`;
    } else if (lease.fence !== item.fence) {
      reason = 'stale fencing token';
    } else if (item.progressSeq > lease.progressSeq) {
      reason = 'claims progress that Tower has not recorded';
    }
    if (reason !== undefined || lease === undefined) {
      const why = reason ?? 'unknown lease';
      unmatched.push({
        leaseId: item.leaseId,
        reason: why,
        cancel: owned && directivesFor(tx, lease, runner).cancel,
      });
      recordAudit(tx, runner.workspaceId, now.toISOString(), {
        kind: 'heartbeat.unmatched',
        runnerId: runner.id,
        leaseId: item.leaseId,
        detail: { reason: why, ...item },
      });
      continue;
    }
    leases.push(viewOf(tx, renew(ctx, tx, lease), runner));
  }
  return { leases, unmatched };
}

/** Matching work evidence extends the lease and is the only thing that does. */
function renew(ctx: FleetContext, tx: SqlDatabase, lease: Lease): Lease {
  const now = ctx.now();
  const expiresAt = iso(now.getTime() + ctx.config.leaseTtlMs);
  tx.run(
    "UPDATE runner_leases SET expires_at = ?, last_proof_at = ? WHERE workspace_id = ? AND id = ? AND status = 'held'",
    [expiresAt, now.toISOString(), lease.workspaceId, lease.id],
  );
  return { ...lease, expiresAt, lastProofAt: now.toISOString() };
}

function recovering(tx: SqlDatabase, runner: Runner): LeaseView[] {
  return liveLeasesOf(tx, runner.workspaceId, runner.id)
    .filter((lease) => lease.status === 'recovering')
    .map((lease) => viewOf(tx, lease, runner));
}

function heartbeatIn(
  ctx: FleetContext,
  tx: SqlDatabase,
  caller: RunnerCaller,
  input: PollInput,
): { runner: Runner; result: HeartbeatResult } {
  const admitted = admit(ctx, tx, caller, input);
  const runner = touch(ctx, tx, admitted, input.capabilities);
  sweep(ctx, tx, runner.workspaceId);
  const evidence = applyEvidence(ctx, tx, runner, input.active);
  return {
    runner,
    result: {
      runner: { id: runner.id, status: runner.status },
      ...evidence,
      reconcile: recovering(tx, runner),
    },
  };
}

/** Liveness plus evidence. It never hands out work. */
export function heartbeat(
  ctx: FleetContext,
  caller: RunnerCaller,
  input: PollInput,
): HeartbeatResult {
  return ctx.transact(
    caller.workspaceId,
    (tx) => heartbeatIn(ctx, tx, caller, input).result,
  );
}

// --------------------------------------------------------------------- claim

function scheduleWorkspace(ctx: FleetContext, workspaceId: string): void {
  try {
    const actor = systemActor(ctx.db, workspaceId, ctx.now().toISOString());
    ctx.core.scheduler.tick(workspaceId, actor, ctx.ids('cor'));
  } catch (error) {
    // One mission failing to schedule must not stop a runner collecting work already dispatched.
    ctx.transact(workspaceId, (tx) =>
      recordAudit(tx, workspaceId, ctx.now().toISOString(), {
        kind: 'schedule.failed',
        detail: { error: error instanceof Error ? error.name : 'unknown' },
      }),
    );
  }
}

/**
 * The poll. Outbound only: the runner asks, Tower answers, nothing is ever pushed.
 *  1. Verify the credential, the bound version and digest, and the supported range. Heartbeat.
 *  2. Run the scheduler for the workspace, so authorized ready work is dispatched with no human step.
 *  3. If the runner has leases in recovery it must reconcile them first and gets no new work.
 *  4. Otherwise grant leases for the attempts dispatched to it, re-checking eligibility now.
 */
export function claim(
  ctx: FleetContext,
  caller: RunnerCaller,
  input: PollInput,
): ClaimResult {
  const { workspaceId } = caller;
  ctx.transact(workspaceId, (tx) => heartbeatIn(ctx, tx, caller, input));
  scheduleWorkspace(ctx, workspaceId);
  return ctx.transact(workspaceId, (tx) => {
    // Everything is checked again: the world moved while the scheduler ran.
    const { runner, result } = heartbeatIn(ctx, tx, caller, input);
    if (result.reconcile.length > 0) {
      return {
        ...result,
        assignments: [],
        withheld: [],
        retryAfterMs: ctx.config.pollIntervalMs,
      };
    }
    return { ...result, ...grant(ctx, tx, runner) };
  });
}

function offersOf(tx: SqlDatabase, runner: Runner) {
  return tx.all<{ id: string; mission_id: string; packet_id: string }>(
    `SELECT a.id, a.mission_id, a.packet_id FROM execution_attempts a
     WHERE a.workspace_id = ? AND a.runner_id = ? AND a.status = 'leased'
       AND NOT EXISTS (SELECT 1 FROM runner_leases l
                        WHERE l.workspace_id = a.workspace_id AND l.attempt_id = a.id)
     ORDER BY a.dispatched_at, a.id`,
    [runner.workspaceId, runner.id],
  );
}

function assignmentOf(
  ctx: FleetContext,
  tx: SqlDatabase,
  runner: Runner,
  lease: Lease,
  mission: MissionState,
  packet: WorkPacket,
): Assignment {
  const checkpoint = latestCheckpoint(tx, lease.workspaceId, lease.attemptId);
  return {
    ...viewOf(tx, lease, runner),
    missionId: mission.id,
    packetId: packet.id,
    ttlMs: ctx.config.leaseTtlMs,
    packet: {
      title: packet.title,
      instructions: packet.instructions,
      scope: packet.scope,
    },
    mission: {
      title: mission.title,
      intent: mission.intent,
      outcome: mission.outcome,
      constraints: mission.constraints,
    },
    resume:
      lease.progressSeq > 0 || checkpoint !== undefined
        ? { progressSeq: lease.progressSeq, checkpoint: checkpoint ?? null }
        : null,
  };
}

function grant(
  ctx: FleetContext,
  tx: SqlDatabase,
  runner: Runner,
): Pick<ClaimResult, 'assignments' | 'withheld' | 'retryAfterMs'> {
  const workspaceId = runner.workspaceId;
  const now = ctx.now();
  const nowIso = now.toISOString();
  const missions = missionsIn(ctx, tx);
  const assignments: Assignment[] = [];
  const withheld: ClaimResult['withheld'] = [];
  let retryAfterMs = ctx.config.pollIntervalMs;

  // Work moved to this runner by reassignment is delivered once.
  for (const lease of liveLeasesOf(tx, workspaceId, runner.id)) {
    if (lease.status !== 'held' || lease.deliveredAt !== null) {
      continue;
    }
    const mission = missions.getMission(workspaceId, lease.missionId);
    const found =
      mission === undefined ? undefined : findPacket(mission, lease);
    if (mission === undefined || found === undefined) {
      continue;
    }
    tx.run(
      'UPDATE runner_leases SET delivered_at = ? WHERE workspace_id = ? AND id = ?',
      [nowIso, workspaceId, lease.id],
    );
    assignments.push(
      assignmentOf(
        ctx,
        tx,
        runner,
        { ...lease, deliveredAt: nowIso },
        mission,
        found.packet,
      ),
    );
  }
  if (runner.status !== 'active') {
    return { assignments, withheld, retryAfterMs };
  }

  for (const offer of offersOf(tx, runner)) {
    const mission = missions.getMission(workspaceId, offer.mission_id);
    const found =
      mission === undefined
        ? undefined
        : findPacket(mission, {
            packetId: offer.packet_id,
            attemptId: offer.id,
          });
    if (mission === undefined || found === undefined) {
      continue;
    }
    const hold = (reason: string) =>
      withheld.push({ attemptId: offer.id, reason });

    if (PAUSING_MISSION_STATES.includes(mission.state)) {
      hold(`mission is ${mission.state}`);
      continue;
    }
    // Eligibility is evaluated again here, from current rows: a capability, scope or quota
    // change since dispatch can withdraw the offer without any separate refresh.
    const reason = ineligibleReason(
      tx,
      ctx.config,
      runner,
      mission.id,
      found.packet,
      now,
      { requireLive: false, load: 'leases' },
    );
    if (reason !== undefined) {
      hold(reason);
      continue;
    }
    const waiting = tx.get<{ failures: number; not_before: string }>(
      'SELECT failures, not_before FROM runner_claim_backoff WHERE workspace_id = ? AND attempt_id = ?',
      [workspaceId, offer.id],
    );
    if (
      waiting !== undefined &&
      Date.parse(waiting.not_before) > now.getTime()
    ) {
      retryAfterMs = Math.min(
        retryAfterMs,
        Date.parse(waiting.not_before) - now.getTime(),
      );
      hold('backing off after losing the scope');
      continue;
    }

    const { scopeKey } = requirementsOf(mission.id, found.packet);
    if (liveLeaseOnScope(tx, workspaceId, scopeKey) !== undefined) {
      const failures = (waiting?.failures ?? 0) + 1;
      const delay = backoffMs(failures, ctx.config.backoff);
      tx.run(
        `INSERT INTO runner_claim_backoff (workspace_id, attempt_id, failures, not_before) VALUES (?, ?, ?, ?)
         ON CONFLICT (workspace_id, attempt_id) DO UPDATE SET failures = excluded.failures, not_before = excluded.not_before`,
        [workspaceId, offer.id, failures, iso(now.getTime() + delay)],
      );
      retryAfterMs = Math.min(retryAfterMs, delay);
      hold('another runner holds the execution scope');
      continue;
    }

    const leaseId = ctx.ids('lse');
    try {
      savepoint(tx, () => {
        tx.run(
          `INSERT INTO runner_leases (workspace_id, id, scope_key, fence, attempt_id, mission_id, packet_id, runner_id,
             status, granted_at, expires_at, last_proof_at, delivered_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'held', ?, ?, ?, ?)`,
          [
            workspaceId,
            leaseId,
            scopeKey,
            nextFence(tx, workspaceId, scopeKey),
            offer.id,
            mission.id,
            found.packet.id,
            runner.id,
            nowIso,
            iso(now.getTime() + ctx.config.leaseTtlMs),
            nowIso,
            nowIso,
          ],
        );
        // The attempt starts in the same transaction as its lease, so one never exists without the other.
        missions.startAttempt(
          { workspaceId, actor: { id: runner.id, kind: 'runner' } },
          mission.id,
          mission.version,
          offer.id,
        );
      });
    } catch (error) {
      if (error instanceof CoreError) {
        hold(`the mission core refused: ${error.code}`);
        continue;
      }
      throw error;
    }
    tx.run(
      'DELETE FROM runner_claim_backoff WHERE workspace_id = ? AND attempt_id = ?',
      [workspaceId, offer.id],
    );
    const lease = getLease(tx, workspaceId, leaseId);
    if (lease === undefined) {
      throw new Error(`Lease ${leaseId} was not written`);
    }
    recordAudit(tx, workspaceId, nowIso, {
      kind: 'lease.granted',
      runnerId: runner.id,
      leaseId,
      detail: { attemptId: offer.id, scopeKey, fence: lease.fence },
    });
    const refreshed = missions.getMission(workspaceId, mission.id) ?? mission;
    assignments.push(
      assignmentOf(ctx, tx, runner, lease, refreshed, found.packet),
    );
  }
  return { assignments, withheld, retryAfterMs };
}

// ------------------------------------------------------- fenced runner writes

type WriteKind = 'progress' | 'checkpoint' | 'receipt' | 'reconcile';

/**
 * The lease a runner may write to right now. Every refusal is recorded. The fencing token is
 * compared first, so a token from before a reconcile or reassignment is always "fenced", whatever
 * else is true of the lease. Expiry comes next: a lease that ran out must be reconciled, not reused.
 */
function requireLive(
  ctx: FleetContext,
  tx: SqlDatabase,
  runner: Runner,
  leaseId: string,
  fence: number,
  kind: WriteKind,
): Lease {
  const lease = getLease(tx, runner.workspaceId, leaseId);
  const refuse = (
    code: ConstructorParameters<typeof FleetError>[0],
    message: string,
    reason: string,
  ) =>
    new FleetError(code, message, {
      kind: `${kind}.rejected`,
      runnerId: runner.id,
      leaseId,
      detail: {
        reason,
        presentedFence: fence,
        ...(lease === undefined || lease.runnerId !== runner.id
          ? {}
          : { currentFence: lease.fence, status: lease.status }),
      },
    });
  if (lease === undefined || lease.runnerId !== runner.id) {
    throw refuse(
      'lease_not_found',
      'No such lease for this runner',
      'unknown lease',
    );
  }
  if (lease.status === 'cancelled') {
    throw refuse('attempt_cancelled', 'The attempt was cancelled', 'cancelled');
  }
  if (lease.status === 'fenced' || fence !== lease.fence) {
    throw refuse(
      'lease_fenced',
      'The fencing token is no longer current',
      'stale fencing token',
    );
  }
  if (lease.status === 'completed' || lease.status === 'released') {
    throw refuse('lease_closed', `The lease is ${lease.status}`, lease.status);
  }
  if (
    lease.status === 'recovering' ||
    Date.parse(lease.expiresAt) <= ctx.now().getTime()
  ) {
    throw refuse(
      'lease_expired',
      'The lease expired; reconcile it first',
      'expired',
    );
  }
  return lease;
}

export interface WriteResult {
  leaseId: string;
  expiresAt: string;
  directives: Directives;
}

export interface ProgressResult extends WriteResult {
  seq: number;
  replayed: boolean;
}

export function recordProgress(
  ctx: FleetContext,
  caller: RunnerCaller,
  leaseId: string,
  input: ProgressInput,
): ProgressResult {
  return ctx.transact(caller.workspaceId, (tx) => {
    const runner = admit(ctx, tx, caller);
    sweep(ctx, tx, runner.workspaceId);
    const lease = requireLive(
      ctx,
      tx,
      runner,
      leaseId,
      input.fence,
      'progress',
    );
    // Redacted before anything else sees it, so neither the row nor its hash holds a secret.
    const message = redactString(input.message);
    const data = redactValue(input.data);
    const hash = sha({ message, data });
    if (input.seq <= lease.progressSeq) {
      const prior = tx.get<{ body_hash: string }>(
        'SELECT body_hash FROM runner_progress WHERE workspace_id = ? AND lease_id = ? AND seq = ?',
        [runner.workspaceId, lease.id, input.seq],
      );
      if (prior?.body_hash === hash) {
        return {
          leaseId: lease.id,
          seq: input.seq,
          replayed: true,
          expiresAt: lease.expiresAt,
          directives: directivesFor(tx, lease, runner),
        };
      }
      throw new FleetError(
        'progress_conflict',
        `Progress ${input.seq} was already recorded differently`,
        {
          kind: 'progress.rejected',
          runnerId: runner.id,
          leaseId: lease.id,
          detail: {
            reason: 'sequence reused with a different body',
            seq: input.seq,
          },
        },
      );
    }
    if (input.seq !== lease.progressSeq + 1) {
      throw new FleetError(
        'progress_conflict',
        `Expected progress ${lease.progressSeq + 1}`,
        {
          kind: 'progress.rejected',
          runnerId: runner.id,
          leaseId: lease.id,
          detail: {
            reason: 'sequence gap',
            seq: input.seq,
            expected: lease.progressSeq + 1,
          },
        },
      );
    }
    const at = ctx.now().toISOString();
    tx.run(
      `INSERT INTO runner_progress (workspace_id, lease_id, seq, runner_id, fence, body_hash, message, data_json, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        runner.workspaceId,
        lease.id,
        input.seq,
        runner.id,
        lease.fence,
        hash,
        message,
        JSON.stringify(data),
        at,
      ],
    );
    tx.run(
      'UPDATE runner_leases SET progress_seq = ? WHERE workspace_id = ? AND id = ?',
      [input.seq, runner.workspaceId, lease.id],
    );
    const renewed = renew(ctx, tx, lease);
    return {
      leaseId: lease.id,
      seq: input.seq,
      replayed: false,
      expiresAt: renewed.expiresAt,
      directives: directivesFor(tx, lease, runner),
    };
  });
}

export interface CheckpointResult extends WriteResult {
  checkpointId: string;
}

export function recordCheckpoint(
  ctx: FleetContext,
  caller: RunnerCaller,
  leaseId: string,
  input: CheckpointInput,
): CheckpointResult {
  return ctx.transact(caller.workspaceId, (tx) => {
    const runner = admit(ctx, tx, caller);
    sweep(ctx, tx, runner.workspaceId);
    const lease = requireLive(
      ctx,
      tx,
      runner,
      leaseId,
      input.fence,
      'checkpoint',
    );
    const id = ctx.ids('chk');
    tx.run(
      `INSERT INTO runner_checkpoints (workspace_id, id, lease_id, attempt_id, scope_key, runner_id, fence, ref, commit_sha, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        runner.workspaceId,
        id,
        lease.id,
        lease.attemptId,
        lease.scopeKey,
        runner.id,
        lease.fence,
        redactString(input.ref),
        input.commit,
        ctx.now().toISOString(),
      ],
    );
    const renewed = renew(ctx, tx, lease);
    return {
      checkpointId: id,
      leaseId: lease.id,
      expiresAt: renewed.expiresAt,
      directives: directivesFor(tx, lease, runner),
    };
  });
}

export interface ReceiptResult {
  receiptId: string;
  leaseId: string;
  attemptId: string;
  outcome: 'succeeded' | 'failed';
  recordedAt: string;
  /** True when this call repeated one Tower had already accepted. */
  replayed: boolean;
}

/** Reports the attempt's outcome to the mission core. The runner's own report when the core allows it, else relayed. */
function reportToCore(
  ctx: FleetContext,
  tx: SqlDatabase,
  lease: Lease,
  runner: Runner | undefined,
  outcome: 'succeeded' | 'failed',
  summary: string,
  fallbackActor: string,
): void {
  const missions = missionsIn(ctx, tx);
  const mission = missions.getMission(lease.workspaceId, lease.missionId);
  const found = mission === undefined ? undefined : findPacket(mission, lease);
  if (mission === undefined || found === undefined) {
    throw new FleetError(
      'lease_closed',
      'The attempt is no longer part of its mission',
    );
  }
  // The core lets a runner report only an attempt dispatched to it. After a reassignment the
  // holder is not that runner, so Tower relays the report as itself and says whose it was.
  const direct = runner !== undefined && found.attempt.runnerId === runner.id;
  const actor: Actor = direct
    ? { id: runner.id, kind: 'runner' }
    : systemActor(tx, lease.workspaceId, ctx.now().toISOString());
  const text = direct ? summary : `[${fallbackActor}] ${summary}`.trim();
  missions.reportAttempt(
    { workspaceId: lease.workspaceId, actor },
    mission.id,
    mission.version,
    lease.attemptId,
    outcome,
    text === '' ? null : text,
  );
}

export function recordReceipt(
  ctx: FleetContext,
  caller: RunnerCaller,
  leaseId: string,
  input: ReceiptInput,
): ReceiptResult {
  return ctx.transact(caller.workspaceId, (tx) => {
    const runner = admit(ctx, tx, caller);
    const summary = redactString(input.summary);
    const evidence = redactValue(input.evidence);
    const hash = sha({ leaseId, outcome: input.outcome, summary, evidence });

    // A repeat is answered before any lease check: the lease is closed by the first receipt.
    const prior = tx.get<{
      lease_id: string;
      attempt_id: string;
      outcome: 'succeeded' | 'failed';
      body_hash: string;
      recorded_at: string;
    }>(
      'SELECT lease_id, attempt_id, outcome, body_hash, recorded_at FROM runner_receipts WHERE workspace_id = ? AND runner_id = ? AND receipt_id = ?',
      [runner.workspaceId, runner.id, input.receiptId],
    );
    if (prior !== undefined) {
      if (prior.body_hash === hash && prior.lease_id === leaseId) {
        return {
          receiptId: input.receiptId,
          leaseId,
          attemptId: prior.attempt_id,
          outcome: prior.outcome,
          recordedAt: prior.recorded_at,
          replayed: true,
        };
      }
      throw new FleetError(
        'receipt_conflict',
        'This receipt id was already used for a different receipt',
        {
          kind: 'receipt.rejected',
          runnerId: runner.id,
          leaseId,
          detail: {
            reason: 'receipt id reused with a different body',
            receiptId: input.receiptId,
          },
        },
      );
    }

    sweep(ctx, tx, runner.workspaceId);
    const lease = requireLive(ctx, tx, runner, leaseId, input.fence, 'receipt');
    const recordedAt = ctx.now().toISOString();
    tx.run(
      `INSERT INTO runner_receipts (workspace_id, runner_id, receipt_id, lease_id, attempt_id, fence, outcome, body_hash, summary, evidence_json, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        runner.workspaceId,
        runner.id,
        input.receiptId,
        lease.id,
        lease.attemptId,
        lease.fence,
        input.outcome,
        hash,
        summary,
        JSON.stringify(evidence),
        recordedAt,
      ],
    );
    reportToCore(
      ctx,
      tx,
      lease,
      runner,
      input.outcome,
      summary,
      `runner ${runner.id}`,
    );
    closeLease(
      ctx,
      tx,
      lease,
      'completed',
      `receipt ${input.receiptId}: ${input.outcome}`,
    );
    return {
      receiptId: input.receiptId,
      leaseId: lease.id,
      attemptId: lease.attemptId,
      outcome: input.outcome,
      recordedAt,
      replayed: false,
    };
  });
}

export interface ReconcileResult {
  lease: LeaseView;
  /** Where Tower's record of the attempt ends. The runner resends anything past it. */
  resume: {
    progressSeq: number;
    checkpoint: { ref: string; commit: string | null } | null;
  };
}

/**
 * The original runner coming back. If nobody took the work over, it gets the lease back under a
 * new fencing token and the old one dies. If the work moved, the old token is fenced and refused.
 */
export function reconcile(
  ctx: FleetContext,
  caller: RunnerCaller,
  leaseId: string,
  input: ReconcileInput,
): ReconcileResult {
  return ctx.transact(caller.workspaceId, (tx) => {
    const admitted = admit(ctx, tx, caller, input);
    const runner = touch(ctx, tx, admitted, undefined);
    sweep(ctx, tx, runner.workspaceId);
    const lease = getLease(tx, runner.workspaceId, leaseId);
    const refuse = (
      code: ConstructorParameters<typeof FleetError>[0],
      message: string,
      reason: string,
    ) =>
      new FleetError(code, message, {
        kind: 'reconcile.rejected',
        runnerId: runner.id,
        leaseId,
        detail: {
          reason,
          presentedFence: input.fence,
          ...(lease === undefined
            ? {}
            : { status: lease.status, currentFence: lease.fence }),
        },
      });
    if (lease === undefined || lease.runnerId !== runner.id) {
      throw refuse(
        'lease_not_found',
        'No such lease for this runner',
        'unknown lease',
      );
    }
    if (lease.status === 'cancelled') {
      throw refuse(
        'attempt_cancelled',
        'The attempt was cancelled',
        'cancelled',
      );
    }
    if (lease.status === 'fenced') {
      throw refuse(
        'lease_fenced',
        'The work moved to another runner',
        'reassigned while away',
      );
    }
    if (lease.status === 'completed' || lease.status === 'released') {
      throw refuse(
        'lease_closed',
        `The lease is ${lease.status}`,
        lease.status,
      );
    }
    const resume = {
      progressSeq: lease.progressSeq,
      checkpoint:
        latestCheckpoint(tx, runner.workspaceId, lease.attemptId) ?? null,
    };
    // A retry whose answer was lost presents the fence this reconcile replaced.
    if (lease.status === 'held' && lease.reconciledFrom === input.fence) {
      return { lease: viewOf(tx, lease, runner), resume };
    }
    if (lease.status !== 'recovering' || input.fence !== lease.fence) {
      throw refuse(
        'lease_fenced',
        'The fencing token is no longer current',
        'stale fencing token',
      );
    }
    const now = ctx.now();
    const fence = nextFence(tx, runner.workspaceId, lease.scopeKey);
    const expiresAt = iso(now.getTime() + ctx.config.leaseTtlMs);
    tx.run(
      `UPDATE runner_leases SET status = 'held', fence = ?, reconciled_from = ?, expires_at = ?, last_proof_at = ?,
         recovering_since = NULL, reassign_failures = 0, reassign_not_before = NULL
       WHERE workspace_id = ? AND id = ?`,
      [
        fence,
        lease.fence,
        expiresAt,
        now.toISOString(),
        runner.workspaceId,
        lease.id,
      ],
    );
    recordAudit(tx, runner.workspaceId, now.toISOString(), {
      kind: 'lease.reconciled',
      runnerId: runner.id,
      leaseId: lease.id,
      detail: {
        fromFence: lease.fence,
        toFence: fence,
        claimedProgressSeq: input.progressSeq,
        recordedProgressSeq: lease.progressSeq,
      },
    });
    const updated = getLease(tx, runner.workspaceId, lease.id) ?? lease;
    return { lease: viewOf(tx, updated, runner), resume };
  });
}

// ------------------------------------------------------------- human actions

export interface HumanCaller {
  workspaceId: string;
  principalId: string;
}

export function updateRunner(
  ctx: FleetContext,
  caller: HumanCaller,
  runnerId: string,
  input: {
    allowedScopes: string[] | undefined;
    maxConcurrent: number | undefined;
    paused: boolean | undefined;
  },
): Runner {
  return ctx.transact(caller.workspaceId, (tx) => {
    const runner = getRunner(tx, caller.workspaceId, runnerId);
    if (runner === undefined) {
      throw new FleetError('runner_not_found', 'No such runner');
    }
    const status =
      runner.status === 'quarantined' || input.paused === undefined
        ? runner.status
        : input.paused
          ? 'paused'
          : 'active';
    const next = {
      status,
      allowedScopes: input.allowedScopes ?? runner.allowedScopes,
      maxConcurrent: input.maxConcurrent ?? runner.maxConcurrent,
    };
    const at = ctx.now().toISOString();
    tx.run(
      'UPDATE runners SET status = ?, allowed_scopes_json = ?, max_concurrent = ?, updated_at = ? WHERE workspace_id = ? AND id = ?',
      [
        next.status,
        JSON.stringify(next.allowedScopes),
        next.maxConcurrent,
        at,
        runner.workspaceId,
        runner.id,
      ],
    );
    recordAudit(tx, runner.workspaceId, at, {
      kind: 'runner.updated',
      runnerId: runner.id,
      actorId: caller.principalId,
      detail: {
        from: {
          status: runner.status,
          allowedScopes: runner.allowedScopes,
          maxConcurrent: runner.maxConcurrent,
        },
        to: next,
      },
    });
    return { ...runner, ...next, updatedAt: at };
  });
}

export function quarantine(
  ctx: FleetContext,
  caller: HumanCaller,
  runnerId: string,
  reason: string | null,
): Runner {
  return ctx.transact(caller.workspaceId, (tx) => {
    const runner = getRunner(tx, caller.workspaceId, runnerId);
    if (runner === undefined) {
      throw new FleetError('runner_not_found', 'No such runner');
    }
    const at = ctx.now().toISOString();
    const text = reason === null ? null : redactString(reason);
    tx.run(
      "UPDATE runners SET status = 'quarantined', quarantine_reason = ?, updated_at = ? WHERE workspace_id = ? AND id = ?",
      [text, at, runner.workspaceId, runner.id],
    );
    // Its work stops being trusted at once: held leases go to recovery, where nothing it sends is accepted.
    for (const lease of liveLeasesOf(tx, runner.workspaceId, runner.id)) {
      if (lease.status === 'held') {
        startRecovery(ctx, tx, lease, at, 'runner quarantined');
      }
    }
    recordAudit(tx, runner.workspaceId, at, {
      kind: 'runner.quarantined',
      runnerId: runner.id,
      actorId: caller.principalId,
      detail: { reason: text },
    });
    return {
      ...runner,
      status: 'quarantined',
      quarantineReason: text,
      updatedAt: at,
    };
  });
}

export function unquarantine(
  ctx: FleetContext,
  caller: HumanCaller,
  runnerId: string,
): Runner {
  return ctx.transact(caller.workspaceId, (tx) => {
    const runner = getRunner(tx, caller.workspaceId, runnerId);
    if (runner === undefined) {
      throw new FleetError('runner_not_found', 'No such runner');
    }
    const at = ctx.now().toISOString();
    tx.run(
      "UPDATE runners SET status = 'active', quarantine_reason = NULL, updated_at = ? WHERE workspace_id = ? AND id = ? AND status = 'quarantined'",
      [at, runner.workspaceId, runner.id],
    );
    recordAudit(tx, runner.workspaceId, at, {
      kind: 'runner.unquarantined',
      runnerId: runner.id,
      actorId: caller.principalId,
      detail: {},
    });
    return getRunner(tx, runner.workspaceId, runner.id) ?? runner;
  });
}

/**
 * A human gives up on a lease that is stuck, for example in recovery with no checkpoint. The
 * scope is freed and the attempt is reported failed, which puts the packet on the usual
 * reject and requeue path. The mission core has no way to un-dispatch an attempt.
 */
export function releaseLease(
  ctx: FleetContext,
  caller: HumanCaller,
  leaseId: string,
  reason: string | null,
): Lease {
  return ctx.transact(caller.workspaceId, (tx) => {
    sweep(ctx, tx, caller.workspaceId);
    const lease = getLease(tx, caller.workspaceId, leaseId);
    if (lease === undefined) {
      throw new FleetError('lease_not_found', 'No such lease');
    }
    if (lease.status !== 'held' && lease.status !== 'recovering') {
      throw new FleetError('lease_closed', `The lease is ${lease.status}`);
    }
    const text = reason === null ? 'no reason given' : redactString(reason);
    reportToCore(
      ctx,
      tx,
      lease,
      undefined,
      'failed',
      `Lease released by ${caller.principalId}: ${text}`,
      'fleet',
    );
    closeLease(ctx, tx, lease, 'released', text, caller.principalId);
    return getLease(tx, caller.workspaceId, leaseId) ?? lease;
  });
}

// --------------------------------------------------------------------- reads

export function sweepWorkspace(ctx: FleetContext, workspaceId: string): void {
  ctx.transact(workspaceId, (tx) => sweep(ctx, tx, workspaceId));
}
