import { createHash } from 'node:crypto';
import type { SqlDatabase } from './database.js';

export interface Migration {
  /** Ordered file-style id, e.g. `0001_initial`. */
  id: string;
  sql: string;
}

/**
 * Applies migrations that have not run yet, each in its own transaction.
 * An applied migration whose SQL has changed since it ran is an error: edit
 * history by adding a new migration instead.
 */
export function applyMigrations(
  db: SqlDatabase,
  migrations: readonly Migration[],
): string[] {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)',
  );
  const ran: string[] = [];
  for (const migration of migrations) {
    const checksum = createHash('sha256').update(migration.sql).digest('hex');
    // The check runs inside the write transaction. A snapshot read taken before
    // another process committed would otherwise re-run its migration.
    const appliedNow = db.transaction((tx) => {
      const previous = tx.get<{ checksum: string }>(
        'SELECT checksum FROM schema_migrations WHERE id = ?',
        [migration.id],
      );
      if (previous !== undefined) {
        if (previous.checksum !== checksum) {
          throw new Error(
            `Migration ${migration.id} changed after it was applied`,
          );
        }
        return false;
      }
      tx.exec(migration.sql);
      tx.run(
        'INSERT INTO schema_migrations (id, checksum, applied_at) VALUES (?, ?, ?)',
        [migration.id, checksum, new Date().toISOString()],
      );
      return true;
    });
    if (appliedNow) {
      ran.push(migration.id);
    }
  }
  return ran;
}
