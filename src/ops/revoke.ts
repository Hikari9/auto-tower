import type { Actor } from '../core/types.js';
import type { SqlDatabase } from '../storage/database.js';
import { HALT_REASON_MAX, HaltForbiddenError } from './halt.js';

/**
 * Credential revocation for an incident. Tower has no route that revokes a token or disables a
 * principal, since a leaked token must not be able to do either, so a person does it on the host
 * with `pnpm ops`. Both actions take effect on the next request: the token check reads these rows
 * every time. Each is recorded, with who did it and why, in an append-only table.
 */

export class RevocationError extends Error {
  override readonly name = 'RevocationError';
  constructor(
    readonly code: 'not_found' | 'would_lock_out',
    message: string,
  ) {
    super(message);
  }
}

function requireHuman(actor: Actor): void {
  if (actor.kind !== 'human') {
    throw new HaltForbiddenError(actor.kind);
  }
}

const cleanReason = (reason: string | null | undefined): string | null =>
  reason?.trim().slice(0, HALT_REASON_MAX) || null;

function record(
  db: SqlDatabase,
  input: {
    workspaceId: string;
    kind: 'token' | 'principal';
    targetId: string;
    actor: Actor;
    reason: string | null;
    at: string;
  },
): void {
  db.run(
    `INSERT INTO ops_revocations (workspace_id, kind, target_id, actor_id, reason, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      input.workspaceId,
      input.kind,
      input.targetId,
      input.actor.id,
      input.reason,
      input.at,
    ],
  );
}

/** Revokes one API token. Revoking a revoked token changes nothing and is still recorded. */
export function revokeTokenById(
  db: SqlDatabase,
  input: {
    workspaceId: string;
    tokenId: string;
    actor: Actor;
    reason?: string | null;
    now?: Date;
  },
): { revoked: boolean } {
  requireHuman(input.actor);
  const at = (input.now ?? new Date()).toISOString();
  return db.transaction((tx) => {
    const row = tx.get<{ revoked_at: string | null }>(
      'SELECT revoked_at FROM api_tokens WHERE id = ? AND workspace_id = ?',
      [input.tokenId, input.workspaceId],
    );
    if (row === undefined) {
      throw new RevocationError(
        'not_found',
        `No token ${input.tokenId} in this workspace`,
      );
    }
    tx.run(
      'UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL',
      [at, input.tokenId, input.workspaceId],
    );
    record(tx, {
      workspaceId: input.workspaceId,
      kind: 'token',
      targetId: input.tokenId,
      actor: input.actor,
      reason: cleanReason(input.reason),
      at,
    });
    return { revoked: row.revoked_at === null };
  });
}

/**
 * Disables a principal and revokes every token it holds. Refused when it would leave the workspace
 * with no enabled person, since nobody could then undo anything.
 */
export function disablePrincipal(
  db: SqlDatabase,
  input: {
    workspaceId: string;
    principalId: string;
    actor: Actor;
    reason?: string | null;
    now?: Date;
  },
): { tokensRevoked: number } {
  requireHuman(input.actor);
  const at = (input.now ?? new Date()).toISOString();
  return db.transaction((tx) => {
    const target = tx.get<{ kind: string; disabled_at: string | null }>(
      'SELECT kind, disabled_at FROM principals WHERE id = ? AND workspace_id = ?',
      [input.principalId, input.workspaceId],
    );
    if (target === undefined) {
      throw new RevocationError(
        'not_found',
        `No principal ${input.principalId} in this workspace`,
      );
    }
    if (target.kind === 'human' && target.disabled_at === null) {
      const others = tx.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM principals
         WHERE workspace_id = ? AND kind = 'human' AND disabled_at IS NULL AND id != ?`,
        [input.workspaceId, input.principalId],
      );
      if ((others?.n ?? 0) === 0) {
        throw new RevocationError(
          'would_lock_out',
          'This is the last enabled person in the workspace. Create another person first, so someone can still resume and undo.',
        );
      }
    }
    tx.run(
      'UPDATE principals SET disabled_at = ? WHERE id = ? AND workspace_id = ? AND disabled_at IS NULL',
      [at, input.principalId, input.workspaceId],
    );
    const tokens = tx.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM api_tokens WHERE principal_id = ? AND workspace_id = ? AND revoked_at IS NULL',
      [input.principalId, input.workspaceId],
    );
    tx.run(
      'UPDATE api_tokens SET revoked_at = ? WHERE principal_id = ? AND workspace_id = ? AND revoked_at IS NULL',
      [at, input.principalId, input.workspaceId],
    );
    record(tx, {
      workspaceId: input.workspaceId,
      kind: 'principal',
      targetId: input.principalId,
      actor: input.actor,
      reason: cleanReason(input.reason),
      at,
    });
    return { tokensRevoked: tokens?.n ?? 0 };
  });
}

export interface RevocationRecord {
  seq: number;
  kind: 'token' | 'principal';
  targetId: string;
  actorId: string;
  reason: string | null;
  recordedAt: string;
}

export function revocationHistory(
  db: SqlDatabase,
  workspaceId: string,
  page: { afterSeq: number; limit: number },
): RevocationRecord[] {
  return db
    .all<{
      seq: number;
      kind: 'token' | 'principal';
      target_id: string;
      actor_id: string;
      reason: string | null;
      recorded_at: string;
    }>(
      `SELECT seq, kind, target_id, actor_id, reason, recorded_at FROM ops_revocations
       WHERE workspace_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
      [workspaceId, page.afterSeq, page.limit],
    )
    .map((row) => ({
      seq: row.seq,
      kind: row.kind,
      targetId: row.target_id,
      actorId: row.actor_id,
      reason: row.reason,
      recordedAt: row.recorded_at,
    }));
}
