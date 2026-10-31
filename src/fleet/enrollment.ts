import { createPrincipal } from '../auth/principals.js';
import { issueToken, revokeToken } from '../auth/tokens.js';
import type { FleetContext } from './context.js';
import { FleetError } from './errors.js';
import type { RegisterInput } from './inputs.js';
import { recordAudit } from './store.js';
import { inSupportedRange } from './version.js';

/** Runner credentials hold only the runner scopes. They never carry mission or policy scopes. */
export const RUNNER_CREDENTIAL_SCOPES = [
  'runner:read',
  'runner:write',
] as const;

/** The enrollment token can read and nothing else. It cannot claim work or write anything. */
export const ENROLLMENT_TOKEN_SCOPES = ['runner:read'] as const;

export interface IssueEnrollment {
  workspaceId: string;
  issuedBy: string;
  name: string;
  version: string;
  buildDigest: string;
  allowedScopes: string[];
  maxConcurrent: number;
  expiresInSeconds: number | undefined;
}

export interface IssuedEnrollment {
  id: string;
  /** The raw token. Returned once and never stored. */
  token: string;
  expiresAt: string;
  pinned: { version: string; buildDigest: string };
}

/**
 * A human pins the version and build digest the runner must present. The token that comes back
 * is a real, expiring api token for the runner's future principal, valid for registration only.
 */
export function issueEnrollment(
  ctx: FleetContext,
  input: IssueEnrollment,
): IssuedEnrollment {
  const now = ctx.now();
  if (!inSupportedRange(input.version, ctx.config.supportedVersions())) {
    throw new FleetError(
      'version_unsupported',
      `Version ${input.version} is outside the range Tower supports`,
    );
  }
  const ttl = Math.min(
    input.expiresInSeconds === undefined
      ? ctx.config.enrollmentTtlMs.default
      : input.expiresInSeconds * 1_000,
    ctx.config.enrollmentTtlMs.max,
  );
  const expiresAt = new Date(now.getTime() + ttl);
  return ctx.transact(input.workspaceId, (tx) => {
    const principal = createPrincipal(tx, {
      workspaceId: input.workspaceId,
      kind: 'runner',
      name: input.name,
    });
    const issued = issueToken(tx, {
      principalId: principal.id,
      scopes: ENROLLMENT_TOKEN_SCOPES,
      expiresAt,
      now,
    });
    const id = ctx.ids('enr');
    tx.run(
      `INSERT INTO runner_enrollments (id, workspace_id, token_id, principal_id, name, pinned_version, pinned_digest,
         allowed_scopes_json, max_concurrent, issued_by, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.workspaceId,
        issued.id,
        principal.id,
        input.name,
        input.version,
        input.buildDigest,
        JSON.stringify(input.allowedScopes),
        input.maxConcurrent,
        input.issuedBy,
        now.toISOString(),
        expiresAt.toISOString(),
      ],
    );
    recordAudit(tx, input.workspaceId, now.toISOString(), {
      kind: 'enrollment.issued',
      actorId: input.issuedBy,
      detail: {
        enrollmentId: id,
        version: input.version,
        buildDigest: input.buildDigest,
        allowedScopes: input.allowedScopes,
        expiresAt: expiresAt.toISOString(),
      },
    });
    return {
      id,
      token: issued.token,
      expiresAt: expiresAt.toISOString(),
      pinned: { version: input.version, buildDigest: input.buildDigest },
    };
  });
}

interface EnrollmentRow {
  id: string;
  principal_id: string;
  name: string;
  pinned_version: string;
  pinned_digest: string;
  allowed_scopes_json: string;
  max_concurrent: number;
  expires_at: string;
  used_at: string | null;
}

export interface Registration {
  runnerId: string;
  /** The runner credential. Returned once and bound to the pinned version and digest. */
  token: string;
  bound: { version: string; buildDigest: string };
}

/**
 * Redeems the enrollment the caller's token belongs to. The token is revoked in the same
 * transaction, so it works once. A version or digest other than the pinned pair is refused
 * without using the token up, so the right build can still enroll.
 */
export function register(
  ctx: FleetContext,
  caller: { workspaceId: string; tokenId: string },
  input: RegisterInput,
): Registration {
  const now = ctx.now();
  const nowIso = now.toISOString();
  return ctx.transact(caller.workspaceId, (tx) => {
    // Read inside the write transaction: two redemptions race on the single use.
    const row = tx.get<EnrollmentRow>(
      `SELECT id, principal_id, name, pinned_version, pinned_digest, allowed_scopes_json,
              max_concurrent, expires_at, used_at
       FROM runner_enrollments WHERE workspace_id = ? AND token_id = ?`,
      [caller.workspaceId, caller.tokenId],
    );
    if (row === undefined) {
      throw new FleetError(
        'enrollment_invalid',
        'This credential is not an enrollment token',
      );
    }
    const refuse = (
      code: 'enrollment_invalid' | 'version_mismatch' | 'version_unsupported',
      message: string,
      reason: string,
      detail: Record<string, unknown> = {},
    ) =>
      new FleetError(code, message, {
        kind: 'enrollment.rejected',
        detail: { enrollmentId: row.id, reason, ...detail },
      });
    if (row.used_at !== null) {
      throw refuse(
        'enrollment_invalid',
        'The enrollment was already used',
        'already used',
      );
    }
    if (Date.parse(row.expires_at) <= now.getTime()) {
      throw refuse('enrollment_invalid', 'The enrollment expired', 'expired');
    }
    if (
      input.version !== row.pinned_version ||
      input.buildDigest !== row.pinned_digest
    ) {
      throw refuse(
        'version_mismatch',
        'The presented version or build digest is not the one pinned for this enrollment',
        'presented version or digest differs from the pinned one',
        { presentedVersion: input.version, presentedDigest: input.buildDigest },
      );
    }
    if (!inSupportedRange(row.pinned_version, ctx.config.supportedVersions())) {
      throw refuse(
        'version_unsupported',
        'The pinned version is no longer supported',
        'pinned version is no longer supported',
      );
    }

    const issued = issueToken(tx, {
      principalId: row.principal_id,
      scopes: RUNNER_CREDENTIAL_SCOPES,
      now,
    });
    revokeToken(tx, caller.tokenId, now);
    tx.run(
      `INSERT INTO runners (workspace_id, id, name, enrollment_id, token_id, bound_version, bound_digest, status,
         capabilities_json, allowed_scopes_json, max_concurrent, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
      [
        caller.workspaceId,
        row.principal_id,
        row.name,
        row.id,
        issued.id,
        row.pinned_version,
        row.pinned_digest,
        JSON.stringify(input.capabilities),
        row.allowed_scopes_json,
        row.max_concurrent,
        nowIso,
        nowIso,
      ],
    );
    tx.run(
      'UPDATE runner_enrollments SET used_at = ?, runner_id = ? WHERE id = ?',
      [nowIso, row.principal_id, row.id],
    );
    recordAudit(tx, caller.workspaceId, nowIso, {
      kind: 'runner.registered',
      runnerId: row.principal_id,
      detail: {
        enrollmentId: row.id,
        version: row.pinned_version,
        buildDigest: row.pinned_digest,
        capabilities: input.capabilities,
      },
    });
    return {
      runnerId: row.principal_id,
      token: issued.token,
      bound: { version: row.pinned_version, buildDigest: row.pinned_digest },
    };
  });
}
