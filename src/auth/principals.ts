import { newId } from '../shared/ids.js';
import type { SqlDatabase } from '../storage/database.js';

export const PRINCIPAL_KINDS = [
  'human',
  'chief_of_staff',
  'runner',
  'provider_adapter',
] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

export const SCOPES = [
  'mission:read',
  'mission:write',
  'decision:read',
  'decision:write',
  'policy:read',
  'policy:write',
  'runner:read',
  'runner:write',
  'provider:sync',
  'admin:tokens',
] as const;
export type Scope = (typeof SCOPES)[number];

/**
 * Ceiling of scopes each principal kind may ever hold. A token can narrow its
 * scopes but cannot widen them. Only a human may change policy or issue tokens,
 * so a compromised runner or chief of staff cannot grant itself authority.
 */
export const SCOPES_BY_KIND: Readonly<Record<PrincipalKind, readonly Scope[]>> =
  {
    human: SCOPES,
    chief_of_staff: [
      'mission:read',
      'mission:write',
      'decision:read',
      'decision:write',
      'policy:read',
    ],
    runner: ['mission:read', 'runner:read', 'runner:write'],
    provider_adapter: ['mission:read', 'provider:sync'],
  };

export interface Principal {
  id: string;
  workspaceId: string;
  kind: PrincipalKind;
  name: string;
  disabledAt: string | null;
  createdAt: string;
}

export interface PrincipalRow {
  id: string;
  workspace_id: string;
  kind: string;
  name: string;
  disabled_at: string | null;
  created_at: string;
}

export function isPrincipalKind(value: unknown): value is PrincipalKind {
  return (
    typeof value === 'string' &&
    (PRINCIPAL_KINDS as readonly string[]).includes(value)
  );
}

export function isScope(value: string): value is Scope {
  return (SCOPES as readonly string[]).includes(value);
}

export function assertScopesAllowed(
  kind: PrincipalKind,
  scopes: readonly Scope[],
): void {
  const allowed = SCOPES_BY_KIND[kind];
  const denied = scopes.filter((scope) => !allowed.includes(scope));
  if (denied.length > 0) {
    throw new Error(`Scopes not allowed for ${kind}: ${denied.join(', ')}`);
  }
}

export function ensureWorkspace(
  db: SqlDatabase,
  id: string,
  name: string,
): void {
  db.run(
    'INSERT OR IGNORE INTO workspaces (id, name, created_at) VALUES (?, ?, ?)',
    [id, name, new Date().toISOString()],
  );
}

export function createPrincipal(
  db: SqlDatabase,
  input: { workspaceId: string; kind: PrincipalKind; name: string },
): Principal {
  const id = newId('prn');
  db.run(
    'INSERT INTO principals (id, workspace_id, kind, name, created_at) VALUES (?, ?, ?, ?, ?)',
    [id, input.workspaceId, input.kind, input.name, new Date().toISOString()],
  );
  const principal = getPrincipal(db, id);
  if (principal === undefined) {
    throw new Error(`Principal ${id} was not written`);
  }
  return principal;
}

export function getPrincipal(
  db: SqlDatabase,
  id: string,
): Principal | undefined {
  const row = db.get<PrincipalRow>(
    'SELECT id, workspace_id, kind, name, disabled_at, created_at FROM principals WHERE id = ?',
    [id],
  );
  return row === undefined ? undefined : toPrincipal(row);
}

export function toPrincipal(row: PrincipalRow): Principal {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind as PrincipalKind,
    name: row.name,
    disabledAt: row.disabled_at,
    createdAt: row.created_at,
  };
}
