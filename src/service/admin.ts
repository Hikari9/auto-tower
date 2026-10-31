import { randomToken, sha256Hex } from '../domain/crypto.ts';
import { fail } from '../domain/errors.ts';
import type { Actor, PrincipalKind } from '../domain/types.ts';
import type { SqlDriver, SqlValue } from '../store/sql.ts';
import { stmt } from '../store/sql.ts';
import { requireScope, sanitizeScopes } from './auth.ts';
import type { Tower } from './tower.ts';

export const BACKUP_FORMAT = 'auto-tower.backup/v1';

/** Tables in dependency order (parents before children) for restore. */
export const BACKUP_TABLES = [
  'schema_migrations',
  'workspaces',
  'principals',
  'missions',
  'packets',
  'attempts',
  'scope_locks',
  'runners',
  'decisions',
  'decision_links',
  'policy_rules',
  'preferences',
  'rule_proposals',
  'issue_links',
  'integrations',
  'evidence',
  'events',
  'idempotency',
  'webhook_deliveries',
  'flags',
  'health',
] as const;

/**
 * Cloud AI is off in v1. These flags exist so a future classifier or hosted
 * runner can be enabled by policy without redesigning mission state. Enabling
 * one requires an approved provider, model, budget and credential name, and a
 * classifier's output is advisory: nothing reads it as authority.
 */
export const CLOUD_AI_FLAGS = ['cloud_ai.classifier', 'cloud_ai.hosted_runner'] as const;

export interface Backup {
  format: typeof BACKUP_FORMAT;
  exportedAt: string;
  tables: Record<string, Record<string, SqlValue>[]>;
}

export class AdminService {
  private readonly t: Tower;

  constructor(t: Tower) {
    this.t = t;
  }

  /** First run: create the workspace and its owner. Refuses if a workspace exists. */
  async bootstrap(input: { workspaceName: string; ownerName: string }): Promise<{ workspaceId: string; ownerId: string; ownerToken: string }> {
    const existing = await this.t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM workspaces');
    if ((existing?.n ?? 0) > 0) fail('conflict', 'Tower is already initialized');
    const workspaceId = this.t.id('ws');
    const ownerId = this.t.id('usr');
    const ownerToken = `twr_h_${randomToken()}`;
    const now = this.t.now();
    const owner = { principal: { id: ownerId, workspaceId, kind: 'human' as const, name: input.ownerName, scopes: [], status: 'active' as const }, correlationId: 'bootstrap' };
    const tx = this.t.uow(owner);
    tx.run('INSERT INTO workspaces (id, name, policy_version, halted, settings_json, version, created_at) VALUES (?, ?, 0, 0, ?, 1, ?)', workspaceId, input.workspaceName, JSON.stringify({ chiefOfStaff: 'Rico Mode', officeEngine: 'auto-office' }), now);
    tx.event({ stream: 'workspace', id: workspaceId, expected: 0, type: 'workspace.created', payload: { name: input.workspaceName } });
    tx.run(
      'INSERT INTO principals (id, workspace_id, kind, name, scopes_json, token_hash, status, version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)',
      ownerId,
      workspaceId,
      'human',
      input.ownerName,
      JSON.stringify(sanitizeScopes('human', undefined)),
      await sha256Hex(ownerToken),
      'active',
      now,
    );
    tx.event({ stream: 'principal', id: ownerId, expected: 0, type: 'principal.created', payload: { kind: 'human', name: input.ownerName } });
    for (const key of CLOUD_AI_FLAGS) tx.run('INSERT INTO flags (workspace_id, key, value_json, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)', workspaceId, key, JSON.stringify({ enabled: false }), ownerId, now);
    await tx.commit(this.t.db);
    return { workspaceId, ownerId, ownerToken };
  }

  /** Issue a credential for a chief of staff client, a runner, or another human device. Shown once. */
  async issueToken(actor: Actor, input: { kind: PrincipalKind; name: string; scopes?: string[] }): Promise<{ principalId: string; token: string; scopes: string[] }> {
    requireScope(actor, 'admin');
    if (!['human', 'chief', 'runner'].includes(input.kind)) fail('invalid', `cannot issue tokens for ${input.kind}`);
    const id = this.t.id(input.kind === 'runner' ? 'rnp' : input.kind === 'chief' ? 'cos' : 'usr');
    const token = `twr_${input.kind[0]}_${randomToken()}`;
    const scopes = sanitizeScopes(input.kind, input.scopes);
    const tx = this.t.uow(actor);
    tx.run(
      'INSERT INTO principals (id, workspace_id, kind, name, scopes_json, token_hash, status, version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)',
      id,
      actor.principal.workspaceId,
      input.kind,
      input.name,
      JSON.stringify(scopes),
      await sha256Hex(token),
      'active',
      tx.now,
    );
    tx.event({ stream: 'principal', id, expected: 0, type: 'principal.created', payload: { kind: input.kind, name: input.name, scopes } });
    await tx.commit(this.t.db);
    return { principalId: id, token, scopes };
  }

  /** Rotate a credential: the old token stops working immediately. */
  async rotateToken(actor: Actor, principalId: string): Promise<{ token: string }> {
    requireScope(actor, 'admin');
    const p = (await this.t.repo.principal(actor.principal.workspaceId, principalId)) ?? fail('not_found', 'principal not found');
    if (p.status !== 'active') fail('invalid_transition', 'principal is revoked');
    const token = `twr_${p.kind[0]}_${randomToken()}`;
    const tx = this.t.uow(actor);
    const v = tx.event({ stream: 'principal', id: p.id, expected: p.version, type: 'principal.token_rotated' });
    tx.run('UPDATE principals SET token_hash = ?, version = ? WHERE id = ?', await sha256Hex(token), v, p.id);
    await tx.commit(this.t.db);
    return { token };
  }

  async revokePrincipal(actor: Actor, principalId: string): Promise<void> {
    requireScope(actor, 'admin');
    if (principalId === actor.principal.id) fail('invalid', 'you cannot revoke your own credential');
    const p = (await this.t.repo.principal(actor.principal.workspaceId, principalId)) ?? fail('not_found', 'principal not found');
    if (p.status === 'revoked') return;
    const tx = this.t.uow(actor);
    const v = tx.event({ stream: 'principal', id: p.id, expected: p.version, type: 'principal.revoked' });
    tx.run("UPDATE principals SET status = 'revoked', token_hash = NULL, version = ? WHERE id = ?", v, p.id);
    await tx.commit(this.t.db);
  }

  async listPrincipals(actor: Actor) {
    requireScope(actor, 'admin');
    return this.t.repo.principals(actor.principal.workspaceId);
  }

  /** Emergency halt: no claims, no guarded effects, no Tower-performed closes. Reads keep working. */
  async setHalt(actor: Actor, halted: boolean, reason = ''): Promise<{ halted: boolean }> {
    requireScope(actor, 'admin');
    await this.t.retrying(async () => {
      const ws = await this.t.repo.workspace(actor.principal.workspaceId);
      const tx = this.t.uow(actor);
      const v = tx.event({ stream: 'workspace', id: ws.id, expected: ws.version, type: halted ? 'workspace.halted' : 'workspace.resumed', payload: { reason } });
      tx.run('UPDATE workspaces SET halted = ?, version = ? WHERE id = ?', halted ? 1 : 0, v, ws.id);
      await tx.commit(this.t.db);
    });
    return { halted };
  }

  async setFlag(actor: Actor, key: string, value: Record<string, unknown>): Promise<void> {
    requireScope(actor, 'admin');
    if ((CLOUD_AI_FLAGS as readonly string[]).includes(key) && value.enabled) {
      const missing = ['provider', 'model', 'monthlyBudgetUsd', 'credentialSecret'].filter((k) => value[k] === undefined || value[k] === '');
      if (missing.length) fail('invalid', `enabling ${key} requires an approved ${missing.join(', ')}`);
      if (value.grantsAuthority) fail('invalid', 'a cloud AI provider can never be granted decision authority by a flag');
    }
    const ws = await this.t.repo.workspace(actor.principal.workspaceId);
    const tx = this.t.uow(actor);
    const v = tx.event({ stream: 'workspace', id: ws.id, expected: ws.version, type: 'flag.changed', payload: { key, value } });
    tx.run('UPDATE workspaces SET version = ? WHERE id = ?', v, ws.id);
    tx.run(
      'INSERT INTO flags (workspace_id, key, value_json, updated_by, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(workspace_id, key) DO UPDATE SET value_json = excluded.value_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at',
      ws.id,
      key,
      JSON.stringify(value),
      actor.principal.id,
      tx.now,
    );
    await tx.commit(this.t.db);
  }

  async activity(actor: Actor, f: { afterSeq?: number; limit?: number; missionId?: string } = {}) {
    requireScope(actor, 'missions:read');
    return this.t.repo.events(actor.principal.workspaceId, f);
  }

  /** Operational health: what is waiting, stale, failing or switched off. */
  async health(actor: Actor) {
    requireScope(actor, 'missions:read');
    const ws = actor.principal.workspaceId;
    const now = this.t.now();
    const count = async (sql: string, ...params: SqlValue[]) => (await this.t.db.all<{ k: string; n: number }>(sql, params)).reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.k]: r.n }), {});
    const [workspace, flags, missions, packets, runners, decisions, staleLeases, providerErrors, healthRows] = await Promise.all([
      this.t.repo.workspace(ws),
      this.t.repo.flags(ws),
      count('SELECT state AS k, COUNT(*) AS n FROM missions WHERE workspace_id = ? GROUP BY state', ws),
      count('SELECT state AS k, COUNT(*) AS n FROM packets WHERE workspace_id = ? GROUP BY state', ws),
      count('SELECT status AS k, COUNT(*) AS n FROM runners WHERE workspace_id = ? GROUP BY status', ws),
      count("SELECT audience AS k, COUNT(*) AS n FROM decisions WHERE workspace_id = ? AND status = 'open' GROUP BY audience", ws),
      this.t.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM attempts WHERE workspace_id = ? AND state IN ('leased','running') AND lease_expires_at < ?", [ws, now]),
      this.t.db.all<{ id: string; url: string; last_error: string; error_count: number }>('SELECT id, url, last_error, error_count FROM issue_links WHERE workspace_id = ? AND last_error IS NOT NULL', [ws]),
      this.t.db.all<{ key: string; value_json: string; updated_at: string }>('SELECT key, value_json, updated_at FROM health'),
    ]);
    const health = Object.fromEntries(healthRows.map((r) => [r.key, { ...JSON.parse(r.value_json), updatedAt: r.updated_at }]));
    const signals: string[] = [];
    if (workspace.halted) signals.push('emergency halt is active');
    if ((runners.online ?? 0) === 0 && (packets.ready ?? 0) > 0) signals.push('ready work is waiting for an eligible runner');
    if ((staleLeases?.n ?? 0) > 0) signals.push(`${staleLeases!.n} leases expired since the last sweep`);
    if (providerErrors.length) signals.push(`${providerErrors.length} issue links have provider errors`);
    const lastSweep = health.sweep?.updatedAt as string | undefined;
    if (!lastSweep || Date.parse(now) - Date.parse(lastSweep) > 10 * 60_000) signals.push('scheduler sweep has not run in the last 10 minutes');
    if (health.storage?.lastError) signals.push(`storage error: ${health.storage.lastError}`);
    return {
      now,
      halted: workspace.halted,
      policyVersion: workspace.policyVersion,
      cloudAi: Object.fromEntries(CLOUD_AI_FLAGS.map((k) => [k, Boolean((flags[k] as { enabled?: boolean } | undefined)?.enabled)])),
      missions,
      packets,
      runners,
      openDecisions: decisions,
      staleLeases: staleLeases?.n ?? 0,
      providerErrors,
      scheduler: health.sweep ?? null,
      signals,
      ok: signals.length === 0 || (signals.length === 1 && signals[0] === 'ready work is waiting for an eligible runner'),
    };
  }

  async exportBackup(actor: Actor): Promise<Backup> {
    requireScope(actor, 'admin');
    return exportBackup(this.t.db, this.t.now());
  }
}

export async function exportBackup(db: SqlDriver, exportedAt: string): Promise<Backup> {
  const tables: Backup['tables'] = {};
  for (const t of BACKUP_TABLES) tables[t] = await db.all<Record<string, SqlValue>>(`SELECT * FROM ${t}`);
  return { format: BACKUP_FORMAT, exportedAt, tables };
}

/**
 * Restore a backup into a freshly migrated, empty database. Refuses a non-empty
 * target so a restore can never merge into or overwrite live state.
 */
export async function restoreBackup(db: SqlDriver, backup: Backup): Promise<Record<string, number>> {
  if (backup.format !== BACKUP_FORMAT) fail('invalid', `unsupported backup format ${String(backup.format)}`);
  const present = await db.first<{ n: number }>('SELECT COUNT(*) AS n FROM workspaces');
  if ((present?.n ?? 0) > 0) fail('conflict', 'restore target is not empty');
  const applied = new Set((await db.all<{ id: string }>('SELECT id FROM schema_migrations')).map((r) => r.id));
  for (const m of backup.tables.schema_migrations ?? []) {
    if (!applied.has(String(m.id))) fail('invalid', `backup needs migration ${String(m.id)}; migrate the target first`);
  }
  const counts: Record<string, number> = {};
  const stmts = [];
  for (const t of BACKUP_TABLES) {
    if (t === 'schema_migrations') continue;
    const rows = backup.tables[t] ?? [];
    counts[t] = rows.length;
    for (const row of rows) {
      const cols = Object.keys(row);
      stmts.push(stmt(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((c) => row[c] ?? null)));
    }
  }
  await db.batch(stmts);
  return counts;
}
