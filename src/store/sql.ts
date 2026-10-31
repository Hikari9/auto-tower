import { TowerError } from '../domain/errors.ts';

export type SqlValue = string | number | null;

export interface Stmt {
  sql: string;
  params: SqlValue[];
}

/**
 * Minimal SQL surface shared by Node (node:sqlite) and Cloudflare D1.
 * `batch` is atomic: all statements commit or none do. There are no interactive
 * transactions, so every write is a pre-computed batch guarded by unique constraints.
 */
export interface SqlDriver {
  all<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T[]>;
  first<T = Record<string, unknown>>(sql: string, params?: SqlValue[]): Promise<T | undefined>;
  batch(stmts: Stmt[]): Promise<void>;
  exec(sql: string): Promise<void>;
}

export const stmt = (sql: string, ...params: SqlValue[]): Stmt => ({ sql, params });

/** Map a driver-level constraint failure to a version conflict. */
export function mapDriverError(err: unknown): never {
  const msg = err instanceof Error ? err.message : String(err);
  if (/UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(msg)) {
    throw new TowerError('conflict', 'concurrent modification; reload and retry', { cause: msg });
  }
  if (/SQLITE_BUSY|database is locked|D1_ERROR.*(overloaded|limit)|exceeded/i.test(msg)) {
    throw new TowerError('unavailable', 'storage is temporarily unavailable; no change was applied', { cause: msg });
  }
  throw err;
}

/** Split a migration file into statements (no semicolons inside our DDL literals). */
export function splitSql(sql: string): string[] {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface Migration {
  id: string;
  sql: string;
}

export async function migrate(db: SqlDriver, migrations: Migration[]): Promise<string[]> {
  await db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const done = new Set((await db.all<{ id: string }>('SELECT id FROM schema_migrations')).map((r) => r.id));
  const applied: string[] = [];
  for (const m of migrations) {
    if (done.has(m.id)) continue;
    await db.batch([
      ...splitSql(m.sql).map((s) => stmt(s)),
      stmt('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)', m.id, new Date().toISOString()),
    ]);
    applied.push(m.id);
  }
  return applied;
}
