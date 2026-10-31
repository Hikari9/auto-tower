import { createHash } from 'node:crypto';
import type { SqlDatabase } from '../storage/database.js';
import { IdempotencyKeyReuseError, VersionConflictError } from './errors.js';

export interface AppendEventInput {
  workspaceId: string;
  streamId: string;
  /** Version the stream must be at before this append: 0 for a new stream. */
  expectedVersion: number;
  type: string;
  payload: unknown;
  /** Principal id of the caller. */
  actorId: string;
  correlationId: string;
  policyRefs?: readonly string[];
  evidenceRefs?: readonly string[];
  /** Scoped to (workspace, actor). A replay with the same body returns the original event. */
  idempotencyKey?: string;
}

export interface StoredEvent {
  seq: number;
  workspaceId: string;
  streamId: string;
  version: number;
  type: string;
  payload: unknown;
  actorId: string;
  correlationId: string;
  policyRefs: string[];
  evidenceRefs: string[];
  recordedAt: string;
}

export interface AppendResult {
  event: StoredEvent;
  /** True when an earlier call with the same idempotency key already wrote this event. */
  replayed: boolean;
}

export interface EventLog {
  append(input: AppendEventInput): AppendResult;
  readStream(workspaceId: string, streamId: string): StoredEvent[];
}

interface EventRow {
  seq: number;
  workspace_id: string;
  stream_id: string;
  version: number;
  type: string;
  payload_json: string;
  actor_id: string;
  correlation_id: string;
  policy_refs_json: string;
  evidence_refs_json: string;
  recorded_at: string;
}

const EVENT_COLUMNS =
  'seq, workspace_id, stream_id, version, type, payload_json, actor_id, correlation_id, policy_refs_json, evidence_refs_json, recorded_at';

/**
 * The log over a database. `clock` stamps `recorded_at`, so a host or test that injects one gets
 * the same time in the event log as in every other record it writes.
 */
export function createEventLog(
  db: SqlDatabase,
  clock: () => Date = () => new Date(),
): EventLog {
  return {
    append(input) {
      if (
        !Number.isInteger(input.expectedVersion) ||
        input.expectedVersion < 0
      ) {
        throw new RangeError('expectedVersion must be a non-negative integer');
      }
      for (const field of [
        'workspaceId',
        'streamId',
        'type',
        'actorId',
        'correlationId',
      ] as const) {
        if (input[field].trim() === '') {
          throw new RangeError(`${field} must not be empty`);
        }
      }
      if (input.idempotencyKey?.trim() === '') {
        throw new RangeError('idempotencyKey must not be empty');
      }
      return db.transaction((tx) => {
        const requestHash = hashRequest(input);
        if (input.idempotencyKey !== undefined) {
          const prior = tx.get<{ request_hash: string; event_seq: number }>(
            'SELECT request_hash, event_seq FROM idempotency_keys WHERE workspace_id = ? AND principal_id = ? AND idempotency_key = ?',
            [input.workspaceId, input.actorId, input.idempotencyKey],
          );
          if (prior !== undefined) {
            if (prior.request_hash !== requestHash) {
              throw new IdempotencyKeyReuseError(input.idempotencyKey);
            }
            return { event: loadBySeq(tx, prior.event_seq), replayed: true };
          }
        }

        const current =
          tx.get<{ version: number }>(
            'SELECT COALESCE(MAX(version), 0) AS version FROM events WHERE workspace_id = ? AND stream_id = ?',
            [input.workspaceId, input.streamId],
          )?.version ?? 0;
        if (current !== input.expectedVersion) {
          throw new VersionConflictError(
            input.streamId,
            input.expectedVersion,
            current,
          );
        }

        const { lastInsertRowid } = tx.run(
          `INSERT INTO events (workspace_id, stream_id, version, type, payload_json, actor_id, correlation_id, policy_refs_json, evidence_refs_json, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            input.workspaceId,
            input.streamId,
            current + 1,
            input.type,
            JSON.stringify(input.payload),
            input.actorId,
            input.correlationId,
            JSON.stringify(input.policyRefs ?? []),
            JSON.stringify(input.evidenceRefs ?? []),
            clock().toISOString(),
          ],
        );
        const seq = Number(lastInsertRowid);

        if (input.idempotencyKey !== undefined) {
          tx.run(
            'INSERT INTO idempotency_keys (workspace_id, principal_id, idempotency_key, request_hash, event_seq, created_at) VALUES (?, ?, ?, ?, ?, ?)',
            [
              input.workspaceId,
              input.actorId,
              input.idempotencyKey,
              requestHash,
              seq,
              clock().toISOString(),
            ],
          );
        }
        return { event: loadBySeq(tx, seq), replayed: false };
      });
    },

    readStream(workspaceId, streamId) {
      return db
        .all<EventRow>(
          `SELECT ${EVENT_COLUMNS} FROM events WHERE workspace_id = ? AND stream_id = ? ORDER BY version`,
          [workspaceId, streamId],
        )
        .map(toStoredEvent);
    },
  };
}

function loadBySeq(db: SqlDatabase, seq: number): StoredEvent {
  const row = db.get<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM events WHERE seq = ?`,
    [seq],
  );
  if (row === undefined) {
    throw new Error(`Event ${seq} is missing`);
  }
  return toStoredEvent(row);
}

function toStoredEvent(row: EventRow): StoredEvent {
  return {
    seq: row.seq,
    workspaceId: row.workspace_id,
    streamId: row.stream_id,
    version: row.version,
    type: row.type,
    payload: JSON.parse(row.payload_json) as unknown,
    actorId: row.actor_id,
    correlationId: row.correlation_id,
    policyRefs: JSON.parse(row.policy_refs_json) as string[],
    evidenceRefs: JSON.parse(row.evidence_refs_json) as string[],
    recordedAt: row.recorded_at,
  };
}

/** Hash of the request body, so a reused idempotency key with a different body is rejected. */
function hashRequest(input: AppendEventInput): string {
  const body = canonicalJson({
    streamId: input.streamId,
    expectedVersion: input.expectedVersion,
    type: input.type,
    payload: input.payload,
    correlationId: input.correlationId,
    policyRefs: input.policyRefs ?? [],
    evidenceRefs: input.evidenceRefs ?? [],
  });
  return createHash('sha256').update(body).digest('hex');
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) => {
    if (
      nested === null ||
      typeof nested !== 'object' ||
      Array.isArray(nested)
    ) {
      return nested;
    }
    return Object.fromEntries(
      Object.entries(nested).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  });
}
