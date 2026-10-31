import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mapDriverError, type Migration, type SqlDriver, type SqlValue, type Stmt } from './sql.ts';

/** Node driver for local dev, tests and the self-hosted server. */
export class NodeSqliteDriver implements SqlDriver {
  readonly db: DatabaseSync;
  /** Test hook: when set, the next batch fails before writing (simulates quota/outage). */
  failNextBatch: Error | null = null;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON');
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL');
  }

  async all<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    return this.db.prepare(sql).all(...params) as T[];
  }

  async first<T>(sql: string, params: SqlValue[] = []): Promise<T | undefined> {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  async batch(stmts: Stmt[]): Promise<void> {
    if (this.failNextBatch) {
      const err = this.failNextBatch;
      this.failNextBatch = null;
      mapDriverError(err);
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const s of stmts) this.db.prepare(s.sql).run(...s.params);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      mapDriverError(err);
    }
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }
}

export function loadMigrations(dir = join(import.meta.dirname, '..', '..', 'migrations')): Migration[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ id: f.replace(/\.sql$/, ''), sql: readFileSync(join(dir, f), 'utf8') }));
}
