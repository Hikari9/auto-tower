import { createHash, randomBytes } from 'node:crypto';
import { newId } from '../shared/ids.js';
import type { SqlDatabase } from '../storage/database.js';
import {
  assertScopesAllowed,
  getPrincipal,
  type Principal,
  type PrincipalRow,
  SCOPES_BY_KIND,
  type Scope,
  toPrincipal,
} from './principals.js';

const TOKEN_PREFIX = 'twr_';

export function generateToken(): string {
  return TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

/**
 * Plain SHA-256 is enough here: tokens carry 256 bits of randomness, so a
 * slow password hash adds nothing. Only this digest is stored.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface IssueTokenInput {
  principalId: string;
  /** Defaults to every scope the principal kind allows. */
  scopes?: readonly Scope[] | undefined;
  expiresAt?: Date | undefined;
  now?: Date | undefined;
}

export interface IssuedToken {
  id: string;
  /** Raw token. Returned once; never stored or logged. */
  token: string;
  principal: Principal;
  scopes: Scope[];
  expiresAt: string | null;
}

export function issueToken(
  db: SqlDatabase,
  input: IssueTokenInput,
): IssuedToken {
  const principal = getPrincipal(db, input.principalId);
  if (principal === undefined) {
    throw new Error(`Unknown principal ${input.principalId}`);
  }
  const scopes = [...new Set(input.scopes ?? SCOPES_BY_KIND[principal.kind])];
  if (scopes.length === 0) {
    throw new Error('A token needs at least one scope');
  }
  assertScopesAllowed(principal.kind, scopes);

  const id = newId('tok');
  const token = generateToken();
  const createdAt = (input.now ?? new Date()).toISOString();
  const expiresAt = input.expiresAt?.toISOString() ?? null;
  db.run(
    `INSERT INTO api_tokens (id, workspace_id, principal_id, token_hash, scopes_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      principal.workspaceId,
      principal.id,
      hashToken(token),
      JSON.stringify(scopes),
      createdAt,
      expiresAt,
    ],
  );
  return { id, token, principal, scopes, expiresAt };
}

export function revokeToken(
  db: SqlDatabase,
  tokenId: string,
  now: Date = new Date(),
): void {
  db.run(
    'UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL',
    [now.toISOString(), tokenId],
  );
}

export interface AuthenticatedToken {
  tokenId: string;
  principal: Principal;
  scopes: Scope[];
}

interface TokenRow extends PrincipalRow {
  token_id: string;
  scopes_json: string;
  expires_at: string | null;
  revoked_at: string | null;
}

/**
 * Resolves a raw bearer token to its principal. Returns undefined for unknown,
 * revoked, expired or disabled credentials, so callers cannot tell them apart.
 */
export function authenticateToken(
  db: SqlDatabase,
  token: string,
  now: Date = new Date(),
): AuthenticatedToken | undefined {
  if (!token.startsWith(TOKEN_PREFIX)) {
    return undefined;
  }
  const row = db.get<TokenRow>(
    `SELECT t.id AS token_id, t.scopes_json, t.expires_at, t.revoked_at,
            p.id, p.workspace_id, p.kind, p.name, p.disabled_at, p.created_at
     FROM api_tokens t
     JOIN principals p ON p.id = t.principal_id
     WHERE t.token_hash = ?`,
    [hashToken(token)],
  );
  if (
    row === undefined ||
    row.revoked_at !== null ||
    row.disabled_at !== null
  ) {
    return undefined;
  }
  if (row.expires_at !== null && Date.parse(row.expires_at) <= now.getTime()) {
    return undefined;
  }
  return {
    tokenId: row.token_id,
    principal: toPrincipal(row),
    scopes: JSON.parse(row.scopes_json) as Scope[],
  };
}
