import type { SqlDatabase } from '../storage/database.js';
import type { AuditDraft } from './errors.js';
import { redactValue } from './redact.js';

export const RUNNER_STATUSES = ['active', 'paused', 'quarantined'] as const;
export type RunnerStatus = (typeof RUNNER_STATUSES)[number];

export const LEASE_STATUSES = [
  'held',
  'recovering',
  'completed',
  'fenced',
  'cancelled',
  'released',
] as const;
export type LeaseStatus = (typeof LEASE_STATUSES)[number];

/** Statuses that occupy the scope. At most one lease per scope is ever in one of these. */
export const LIVE_STATUSES: readonly LeaseStatus[] = ['held', 'recovering'];

interface RunnerRow {
  workspace_id: string;
  id: string;
  name: string;
  token_id: string;
  bound_version: string;
  bound_digest: string;
  status: RunnerStatus;
  quarantine_reason: string | null;
  capabilities_json: string;
  allowed_scopes_json: string;
  max_concurrent: number;
  last_seen_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Runner {
  id: string;
  workspaceId: string;
  name: string;
  /** The one credential this runner may use. Never returned by the API. */
  tokenId: string;
  boundVersion: string;
  boundDigest: string;
  status: RunnerStatus;
  quarantineReason: string | null;
  capabilities: string[];
  allowedScopes: string[];
  maxConcurrent: number;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const RUNNER_COLUMNS =
  'workspace_id, id, name, token_id, bound_version, bound_digest, status, quarantine_reason, capabilities_json, allowed_scopes_json, max_concurrent, last_seen_at, created_at, updated_at';

function toRunner(row: RunnerRow): Runner {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    tokenId: row.token_id,
    boundVersion: row.bound_version,
    boundDigest: row.bound_digest,
    status: row.status,
    quarantineReason: row.quarantine_reason,
    capabilities: JSON.parse(row.capabilities_json) as string[],
    allowedScopes: JSON.parse(row.allowed_scopes_json) as string[],
    maxConcurrent: row.max_concurrent,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getRunner(
  db: SqlDatabase,
  workspaceId: string,
  id: string,
): Runner | undefined {
  const row = db.get<RunnerRow>(
    `SELECT ${RUNNER_COLUMNS} FROM runners WHERE workspace_id = ? AND id = ?`,
    [workspaceId, id],
  );
  return row === undefined ? undefined : toRunner(row);
}

export function listRunners(
  db: SqlDatabase,
  workspaceId: string,
  status?: RunnerStatus,
): Runner[] {
  return db
    .all<RunnerRow>(
      `SELECT ${RUNNER_COLUMNS} FROM runners WHERE workspace_id = ? ${status === undefined ? '' : 'AND status = ?'} ORDER BY created_at, id`,
      status === undefined ? [workspaceId] : [workspaceId, status],
    )
    .map(toRunner);
}

export function publicRunner(runner: Runner, load: number) {
  const { tokenId: _tokenId, ...rest } = runner;
  return { ...rest, load };
}

interface LeaseRow {
  workspace_id: string;
  id: string;
  scope_key: string;
  fence: number;
  attempt_id: string;
  mission_id: string;
  packet_id: string;
  runner_id: string;
  status: LeaseStatus;
  granted_at: string;
  expires_at: string;
  last_proof_at: string;
  delivered_at: string | null;
  recovering_since: string | null;
  reconciled_from: number | null;
  progress_seq: number;
  reassign_failures: number;
  reassign_not_before: string | null;
  closed_at: string | null;
  close_reason: string | null;
}

export interface Lease {
  id: string;
  workspaceId: string;
  scopeKey: string;
  fence: number;
  attemptId: string;
  missionId: string;
  packetId: string;
  runnerId: string;
  status: LeaseStatus;
  grantedAt: string;
  expiresAt: string;
  lastProofAt: string;
  deliveredAt: string | null;
  recoveringSince: string | null;
  reconciledFrom: number | null;
  progressSeq: number;
  reassignFailures: number;
  reassignNotBefore: string | null;
  closedAt: string | null;
  closeReason: string | null;
}

const LEASE_COLUMNS =
  'workspace_id, id, scope_key, fence, attempt_id, mission_id, packet_id, runner_id, status, granted_at, expires_at, last_proof_at, delivered_at, recovering_since, reconciled_from, progress_seq, reassign_failures, reassign_not_before, closed_at, close_reason';

function toLease(row: LeaseRow): Lease {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    scopeKey: row.scope_key,
    fence: row.fence,
    attemptId: row.attempt_id,
    missionId: row.mission_id,
    packetId: row.packet_id,
    runnerId: row.runner_id,
    status: row.status,
    grantedAt: row.granted_at,
    expiresAt: row.expires_at,
    lastProofAt: row.last_proof_at,
    deliveredAt: row.delivered_at,
    recoveringSince: row.recovering_since,
    reconciledFrom: row.reconciled_from,
    progressSeq: row.progress_seq,
    reassignFailures: row.reassign_failures,
    reassignNotBefore: row.reassign_not_before,
    closedAt: row.closed_at,
    closeReason: row.close_reason,
  };
}

export function getLease(
  db: SqlDatabase,
  workspaceId: string,
  id: string,
): Lease | undefined {
  const row = db.get<LeaseRow>(
    `SELECT ${LEASE_COLUMNS} FROM runner_leases WHERE workspace_id = ? AND id = ?`,
    [workspaceId, id],
  );
  return row === undefined ? undefined : toLease(row);
}

export function liveLeases(db: SqlDatabase, workspaceId: string): Lease[] {
  return db
    .all<LeaseRow>(
      `SELECT ${LEASE_COLUMNS} FROM runner_leases WHERE workspace_id = ? AND status IN ('held', 'recovering') ORDER BY granted_at, id`,
      [workspaceId],
    )
    .map(toLease);
}

export function liveLeasesOf(
  db: SqlDatabase,
  workspaceId: string,
  runnerId: string,
): Lease[] {
  return db
    .all<LeaseRow>(
      `SELECT ${LEASE_COLUMNS} FROM runner_leases WHERE workspace_id = ? AND runner_id = ? AND status IN ('held', 'recovering') ORDER BY granted_at, id`,
      [workspaceId, runnerId],
    )
    .map(toLease);
}

export function liveLeaseOnScope(
  db: SqlDatabase,
  workspaceId: string,
  scopeKey: string,
): Lease | undefined {
  const row = db.get<LeaseRow>(
    `SELECT ${LEASE_COLUMNS} FROM runner_leases WHERE workspace_id = ? AND scope_key = ? AND status IN ('held', 'recovering')`,
    [workspaceId, scopeKey],
  );
  return row === undefined ? undefined : toLease(row);
}

export function listLeases(
  db: SqlDatabase,
  workspaceId: string,
  options: { status?: LeaseStatus | undefined; limit: number },
): Lease[] {
  return db
    .all<LeaseRow>(
      `SELECT ${LEASE_COLUMNS} FROM runner_leases WHERE workspace_id = ? ${options.status === undefined ? '' : 'AND status = ?'} ORDER BY granted_at DESC, id LIMIT ?`,
      options.status === undefined
        ? [workspaceId, options.limit]
        : [workspaceId, options.status, options.limit],
    )
    .map(toLease);
}

/** The next fencing token for a scope. Only valid inside the transaction that inserts the lease. */
export function nextFence(
  db: SqlDatabase,
  workspaceId: string,
  scopeKey: string,
): number {
  const row = db.get<{ fence: number }>(
    'SELECT COALESCE(MAX(fence), 0) + 1 AS fence FROM runner_leases WHERE workspace_id = ? AND scope_key = ?',
    [workspaceId, scopeKey],
  );
  return row?.fence ?? 1;
}

export function liveLeaseCount(
  db: SqlDatabase,
  workspaceId: string,
  runnerId: string,
): number {
  return (
    db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM runner_leases WHERE workspace_id = ? AND runner_id = ? AND status IN ('held', 'recovering')",
      [workspaceId, runnerId],
    )?.n ?? 0
  );
}

/** Runners already loaded: live leases plus dispatched attempts no lease has claimed yet. */
export function runnerLoad(
  db: SqlDatabase,
  workspaceId: string,
  runnerId: string,
): number {
  const row = db.get<{ load: number }>(
    `SELECT
       (SELECT COUNT(*) FROM runner_leases
         WHERE workspace_id = ?1 AND runner_id = ?2 AND status IN ('held', 'recovering'))
       + (SELECT COUNT(*) FROM execution_attempts a
           WHERE a.workspace_id = ?1 AND a.runner_id = ?2 AND a.status = 'leased'
             AND NOT EXISTS (SELECT 1 FROM runner_leases l
                              WHERE l.workspace_id = a.workspace_id AND l.attempt_id = a.id))
       AS load`,
    [workspaceId, runnerId],
  );
  return row?.load ?? 0;
}

export interface AuditRecord {
  seq: number;
  at: string;
  kind: string;
  runnerId: string | null;
  leaseId: string | null;
  actorId: string | null;
  detail: unknown;
}

/** Detail is redacted here, so no caller can store a raw secret through the audit. */
export function recordAudit(
  db: SqlDatabase,
  workspaceId: string,
  at: string,
  draft: AuditDraft,
): void {
  db.run(
    'INSERT INTO fleet_audit (workspace_id, at, kind, runner_id, lease_id, actor_id, detail_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [
      workspaceId,
      at,
      draft.kind,
      draft.runnerId ?? null,
      draft.leaseId ?? null,
      draft.actorId ?? null,
      JSON.stringify(redactValue(draft.detail ?? {})),
    ],
  );
}

export function readAudit(
  db: SqlDatabase,
  workspaceId: string,
  options: { afterSeq: number; limit: number },
): AuditRecord[] {
  return db
    .all<{
      seq: number;
      at: string;
      kind: string;
      runner_id: string | null;
      lease_id: string | null;
      actor_id: string | null;
      detail_json: string;
    }>(
      'SELECT seq, at, kind, runner_id, lease_id, actor_id, detail_json FROM fleet_audit WHERE workspace_id = ? AND seq > ? ORDER BY seq LIMIT ?',
      [workspaceId, options.afterSeq, options.limit],
    )
    .map((row) => ({
      seq: row.seq,
      at: row.at,
      kind: row.kind,
      runnerId: row.runner_id,
      leaseId: row.lease_id,
      actorId: row.actor_id,
      detail: JSON.parse(row.detail_json) as unknown,
    }));
}
