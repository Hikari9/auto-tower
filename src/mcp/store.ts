import { createHash } from 'node:crypto';
import { newId } from '../shared/ids.js';
import type { SqlDatabase } from '../storage/database.js';
import { McpToolError } from './errors.js';

export interface SessionRecord {
  id: string;
  workspaceId: string;
  principalId: string;
  protocolVersion: string;
}

interface SessionRow {
  id: string;
  workspace_id: string;
  principal_id: string;
  protocol_version: string;
  closed_at: string | null;
}

/** Open sessions one principal may hold. Opening another closes the least recently used. */
export const MAX_OPEN_SESSIONS = 50;
/** A session idle this long is closed on its next use, and refused. */
export const SESSION_IDLE_TTL_MS = 60 * 60 * 1000;
/** How long a closed session row is kept before it is purged. */
export const CLOSED_SESSION_RETENTION_MS = 24 * 60 * 60 * 1000;
/** How long a stored result can answer a retry. */
export const IDEMPOTENCY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export function openSession(
  db: SqlDatabase,
  input: {
    workspaceId: string;
    principalId: string;
    protocolVersion: string;
    clientName: string | null;
    now: Date;
  },
): SessionRecord {
  const id = newId('mcs');
  const at = input.now.toISOString();
  purgeSessions(db, input.now);
  db.run(
    `UPDATE mcp_sessions SET closed_at = ?
     WHERE workspace_id = ? AND principal_id = ? AND closed_at IS NULL AND id IN (
       SELECT id FROM mcp_sessions
       WHERE workspace_id = ? AND principal_id = ? AND closed_at IS NULL
       ORDER BY last_seen_at DESC, id DESC LIMIT -1 OFFSET ?
     )`,
    [
      at,
      input.workspaceId,
      input.principalId,
      input.workspaceId,
      input.principalId,
      MAX_OPEN_SESSIONS - 1,
    ],
  );
  db.run(
    `INSERT INTO mcp_sessions (id, workspace_id, principal_id, protocol_version, client_name, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.workspaceId,
      input.principalId,
      input.protocolVersion,
      input.clientName,
      at,
      at,
    ],
  );
  return {
    id,
    workspaceId: input.workspaceId,
    principalId: input.principalId,
    protocolVersion: input.protocolVersion,
  };
}

/**
 * Closes every session idle past the TTL, then deletes closed rows past their retention. Nothing
 * else refers to a session row, so a purge cannot orphan an audit entry: audit rows keep the id as text.
 */
export function purgeSessions(db: SqlDatabase, now: Date): void {
  db.run(
    'UPDATE mcp_sessions SET closed_at = ? WHERE closed_at IS NULL AND last_seen_at < ?',
    [
      now.toISOString(),
      new Date(now.getTime() - SESSION_IDLE_TTL_MS).toISOString(),
    ],
  );
  db.run(
    'DELETE FROM mcp_sessions WHERE closed_at IS NOT NULL AND closed_at < ?',
    [new Date(now.getTime() - CLOSED_SESSION_RETENTION_MS).toISOString()],
  );
}

/**
 * The open session this caller owns, or undefined. A session id from another principal or
 * workspace is indistinguishable from an unknown one.
 */
export function findSession(
  db: SqlDatabase,
  id: string,
  caller: { workspaceId: string; principalId: string },
  now: Date,
): SessionRecord | undefined {
  const row = db.get<SessionRow & { last_seen_at: string }>(
    `SELECT id, workspace_id, principal_id, protocol_version, closed_at, last_seen_at FROM mcp_sessions
     WHERE id = ? AND workspace_id = ? AND principal_id = ?`,
    [id, caller.workspaceId, caller.principalId],
  );
  if (row === undefined || row.closed_at !== null) {
    return undefined;
  }
  // An idle session ends. Closing it here, not only in the purge, keeps a stale id from reviving.
  if (Date.parse(row.last_seen_at) < now.getTime() - SESSION_IDLE_TTL_MS) {
    db.run('UPDATE mcp_sessions SET closed_at = ? WHERE id = ?', [
      now.toISOString(),
      id,
    ]);
    return undefined;
  }
  db.run('UPDATE mcp_sessions SET last_seen_at = ? WHERE id = ?', [
    now.toISOString(),
    id,
  ]);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    principalId: row.principal_id,
    protocolVersion: row.protocol_version,
  };
}

/** Closes a session the caller owns. True when one was open. */
export function closeSession(
  db: SqlDatabase,
  id: string,
  caller: { workspaceId: string; principalId: string },
  now: Date,
): boolean {
  if (findSession(db, id, caller, now) === undefined) {
    return false;
  }
  db.run('UPDATE mcp_sessions SET closed_at = ? WHERE id = ?', [
    now.toISOString(),
    id,
  ]);
  return true;
}

/** Stable JSON: object keys sorted, so the same arguments always hash the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function requestHash(
  tool: string,
  args: Record<string, unknown>,
): string {
  return createHash('sha256')
    .update(`${tool}\0${canonical(args)}`)
    .digest('hex');
}

interface IdempotencyRow {
  tool: string;
  request_hash: string;
  result_json: string;
}

/**
 * The stored result for a retry, undefined for a first call. The same key for another tool or
 * other arguments is refused, since replaying the first result would hide that.
 */
export function replayFor(
  db: SqlDatabase,
  caller: { workspaceId: string; principalId: string },
  key: string,
  tool: string,
  hash: string,
): Record<string, unknown> | undefined {
  const row = db.get<IdempotencyRow>(
    `SELECT tool, request_hash, result_json FROM mcp_idempotency
     WHERE workspace_id = ? AND principal_id = ? AND idempotency_key = ?`,
    [caller.workspaceId, caller.principalId, key],
  );
  if (row === undefined) {
    return undefined;
  }
  if (row.tool !== tool || row.request_hash !== hash) {
    throw new McpToolError(
      'idempotency_key_reused',
      'The idempotency key was already used for a different call',
    );
  }
  return JSON.parse(row.result_json) as Record<string, unknown>;
}

export function storeResult(
  db: SqlDatabase,
  caller: { workspaceId: string; principalId: string },
  key: string,
  tool: string,
  hash: string,
  result: Record<string, unknown>,
  now: Date,
): void {
  db.run('DELETE FROM mcp_idempotency WHERE created_at < ?', [
    new Date(now.getTime() - IDEMPOTENCY_RETENTION_MS).toISOString(),
  ]);
  db.run(
    `INSERT OR IGNORE INTO mcp_idempotency (workspace_id, principal_id, idempotency_key, tool, request_hash, result_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      caller.workspaceId,
      caller.principalId,
      key,
      tool,
      hash,
      JSON.stringify(result),
      now.toISOString(),
    ],
  );
}

export function recordAudit(
  db: SqlDatabase,
  entry: {
    workspaceId: string;
    principalId: string;
    sessionId: string | undefined;
    tool: string;
    mutating: boolean;
    outcome: 'ok' | 'replayed' | 'refused' | 'error';
    errorCode: string | null;
    now: Date;
  },
): void {
  db.run(
    `INSERT INTO mcp_audit (workspace_id, principal_id, session_id, tool, mutating, outcome, error_code, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.workspaceId,
      entry.principalId,
      entry.sessionId ?? null,
      entry.tool,
      entry.mutating ? 1 : 0,
      entry.outcome,
      entry.errorCode,
      entry.now.toISOString(),
    ],
  );
}
