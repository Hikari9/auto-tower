import { createHash } from 'node:crypto';
import type { SqlDatabase } from '../../storage/database.js';
import {
  assertScopesAllowed,
  getPrincipal,
  isScope,
  SCOPES_BY_KIND,
  type Scope,
} from '../principals.js';
import type { AuthenticatedToken } from '../tokens.js';
import type { AuthProvider } from './provider.js';

export interface LinkIdentityInput {
  issuer: string;
  subject: string;
  principalId: string;
  /** Ceiling for tokens this identity presents. Defaults to everything the principal kind allows. */
  scopes?: readonly Scope[] | undefined;
  /** The human who made the link. */
  linkedBy: string;
  now?: Date | undefined;
}

/**
 * Lets an external identity act as one Tower principal. Only a human links, so a provider token
 * alone can never create authority, and the scopes are cut to what the principal kind may hold.
 */
export function linkIdentity(db: SqlDatabase, input: LinkIdentityInput): void {
  const principal = getPrincipal(db, input.principalId);
  const linker = getPrincipal(db, input.linkedBy);
  if (principal === undefined || principal.disabledAt !== null) {
    throw new Error(`Unknown or disabled principal ${input.principalId}`);
  }
  if (
    linker === undefined ||
    linker.kind !== 'human' ||
    linker.disabledAt !== null ||
    linker.workspaceId !== principal.workspaceId
  ) {
    throw new Error('Only a human in the same workspace may link an identity');
  }
  if (input.issuer === '' || input.subject === '') {
    throw new Error('An identity needs an issuer and a subject');
  }
  const scopes = [...new Set(input.scopes ?? SCOPES_BY_KIND[principal.kind])];
  if (scopes.length === 0) {
    throw new Error('An identity link needs at least one scope');
  }
  assertScopesAllowed(principal.kind, scopes);
  db.run(
    `INSERT INTO oauth_identities (workspace_id, issuer, subject, principal_id, scopes_json, linked_by, linked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      principal.workspaceId,
      input.issuer,
      input.subject,
      principal.id,
      JSON.stringify(scopes),
      linker.id,
      (input.now ?? new Date()).toISOString(),
    ],
  );
}

export function revokeIdentity(
  db: SqlDatabase,
  issuer: string,
  subject: string,
  now: Date = new Date(),
): void {
  db.run(
    'UPDATE oauth_identities SET revoked_at = ? WHERE issuer = ? AND subject = ? AND revoked_at IS NULL',
    [now.toISOString(), issuer, subject],
  );
}

interface IdentityRow {
  workspace_id: string;
  principal_id: string;
  scopes_json: string;
}

function storedScopes(json: string): Scope[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((s): s is Scope => typeof s === 'string' && isScope(s))
      : [];
  } catch {
    return [];
  }
}

/**
 * Resolves a provider access token to a Tower principal, or to nothing. Every step fails closed:
 * a token not minted for this resource, past its expiry, from an issuer the provider does not
 * list, for an unlinked or revoked identity or a disabled principal authenticates nobody.
 * The scopes are the intersection of what the provider granted, what the link allows and what
 * the principal kind may ever hold.
 */
export async function authenticateOAuth(
  db: SqlDatabase,
  provider: AuthProvider,
  token: string,
  options: { resource: string; now: Date },
): Promise<AuthenticatedToken | undefined> {
  let verified: Awaited<ReturnType<AuthProvider['verifyAccessToken']>>;
  try {
    verified = await provider.verifyAccessToken(token, options.now);
  } catch (error) {
    console.error(
      `oauth verification failed: ${error instanceof Error ? error.name : 'error'}`,
    );
    return undefined;
  }
  if (
    verified === undefined ||
    !provider.authorizationServers.includes(verified.issuer) ||
    !verified.audience.includes(options.resource) ||
    !(verified.expiresAt.getTime() > options.now.getTime())
  ) {
    return undefined;
  }
  const row = db.get<IdentityRow>(
    `SELECT workspace_id, principal_id, scopes_json FROM oauth_identities
     WHERE issuer = ? AND subject = ? AND revoked_at IS NULL`,
    [verified.issuer, verified.subject],
  );
  if (row === undefined) {
    return undefined;
  }
  const principal = getPrincipal(db, row.principal_id);
  if (principal === undefined || principal.disabledAt !== null) {
    return undefined;
  }
  const linked = storedScopes(row.scopes_json);
  const ceiling = SCOPES_BY_KIND[principal.kind];
  const scopes = verified.scopes.filter(
    (scope): scope is Scope =>
      isScope(scope) && linked.includes(scope) && ceiling.includes(scope),
  );
  if (scopes.length === 0) {
    return undefined;
  }
  const tokenId = `oauth_${createHash('sha256')
    .update(`${verified.issuer}\0${verified.subject}`)
    .digest('hex')
    .slice(0, 32)}`;
  return { tokenId, principal, scopes: [...new Set(scopes)] };
}
