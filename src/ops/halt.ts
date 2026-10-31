import type { Actor } from '../core/types.js';
import type { SqlDatabase } from '../storage/database.js';

/**
 * Emergency halt. A halted workspace dispatches nothing new and runs no guarded effect, such as
 * closing a provider issue or spending against a flag. It changes no state: missions, attempts,
 * leases, decisions and policy stay exactly as they were, so lifting the halt resumes from where it
 * stopped. Only a person can halt or resume. Every change is kept in an append-only history.
 *
 * This module reads and writes two tables and nothing else, so any module may ask whether a
 * workspace is halted without taking a dependency on the rest of Tower.
 */

export interface HaltState {
  halted: boolean;
  reason: string | null;
  changedBy: string | null;
  changedAt: string | null;
}

export interface HaltChange {
  seq: number;
  action: 'halt' | 'resume';
  reason: string | null;
  actorId: string;
  recordedAt: string;
}

export class HaltForbiddenError extends Error {
  override readonly name = 'HaltForbiddenError';
  readonly code = 'halt_forbidden';
  constructor(actorKind: string) {
    super(
      `A ${actorKind} cannot halt or resume a workspace. Only a person can.`,
    );
  }
}

export class WorkspaceHaltedError extends Error {
  override readonly name = 'WorkspaceHaltedError';
  readonly code = 'workspace_halted';
  constructor(
    readonly what: string,
    readonly reason: string | null,
  ) {
    super(
      `${what} is stopped: the workspace is halted${reason === null ? '' : ` (${reason})`}. A person can resume it.`,
    );
  }
}

export const HALT_REASON_MAX = 500;

/** A reason as it is stored: trimmed, bounded, and null when blank. */
export const cleanReason = (reason: string | null | undefined): string | null =>
  reason?.trim().slice(0, HALT_REASON_MAX) || null;

interface HaltRow {
  halted: number;
  reason: string | null;
  changed_by: string;
  changed_at: string;
}

export function haltState(db: SqlDatabase, workspaceId: string): HaltState {
  const row = db.get<HaltRow>(
    'SELECT halted, reason, changed_by, changed_at FROM ops_halt WHERE workspace_id = ?',
    [workspaceId],
  );
  return row === undefined
    ? { halted: false, reason: null, changedBy: null, changedAt: null }
    : {
        halted: row.halted === 1,
        reason: row.reason,
        changedBy: row.changed_by,
        changedAt: row.changed_at,
      };
}

export function isHalted(db: SqlDatabase, workspaceId: string): boolean {
  return (
    db.get<{ halted: number }>(
      'SELECT halted FROM ops_halt WHERE workspace_id = ?',
      [workspaceId],
    )?.halted === 1
  );
}

/** Throws unless the workspace is running. `what` names the stopped thing for the message. */
export function requireNotHalted(
  db: SqlDatabase,
  workspaceId: string,
  what: string,
): void {
  const state = haltState(db, workspaceId);
  if (state.halted) {
    throw new WorkspaceHaltedError(what, state.reason);
  }
}

function change(
  db: SqlDatabase,
  input: {
    workspaceId: string;
    actor: Actor;
    action: 'halt' | 'resume';
    reason: string | null;
    now: Date;
  },
): HaltState {
  if (input.actor.kind !== 'human') {
    throw new HaltForbiddenError(input.actor.kind);
  }
  const reason = cleanReason(input.reason);
  const at = input.now.toISOString();
  db.transaction((tx) => {
    tx.run(
      `INSERT INTO ops_halt (workspace_id, halted, reason, changed_by, changed_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id) DO UPDATE SET
         halted = excluded.halted, reason = excluded.reason,
         changed_by = excluded.changed_by, changed_at = excluded.changed_at`,
      [
        input.workspaceId,
        input.action === 'halt' ? 1 : 0,
        reason,
        input.actor.id,
        at,
      ],
    );
    tx.run(
      `INSERT INTO ops_halt_history (workspace_id, action, reason, actor_id, recorded_at)
       VALUES (?, ?, ?, ?, ?)`,
      [input.workspaceId, input.action, reason, input.actor.id, at],
    );
  });
  return haltState(db, input.workspaceId);
}

/** Halts the workspace. Halting a halted workspace updates the reason and records it again. */
export function engageHalt(
  db: SqlDatabase,
  input: {
    workspaceId: string;
    actor: Actor;
    reason: string | null;
    now?: Date;
  },
): HaltState {
  return change(db, {
    ...input,
    action: 'halt',
    now: input.now ?? new Date(),
  });
}

export function liftHalt(
  db: SqlDatabase,
  input: {
    workspaceId: string;
    actor: Actor;
    reason: string | null;
    now?: Date;
  },
): HaltState {
  return change(db, {
    ...input,
    action: 'resume',
    now: input.now ?? new Date(),
  });
}

export function haltHistory(
  db: SqlDatabase,
  workspaceId: string,
  page: { afterSeq: number; limit: number },
): HaltChange[] {
  return db
    .all<{
      seq: number;
      action: 'halt' | 'resume';
      reason: string | null;
      actor_id: string;
      recorded_at: string;
    }>(
      `SELECT seq, action, reason, actor_id, recorded_at FROM ops_halt_history
       WHERE workspace_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
      [workspaceId, page.afterSeq, page.limit],
    )
    .map((row) => ({
      seq: row.seq,
      action: row.action,
      reason: row.reason,
      actorId: row.actor_id,
      recordedAt: row.recorded_at,
    }));
}
