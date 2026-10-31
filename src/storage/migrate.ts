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
  const applied = new Map(
    db
      .all<{ id: string; checksum: string }>(
        'SELECT id, checksum FROM schema_migrations',
      )
      .map((row) => [row.id, row.checksum]),
  );
  const ran: string[] = [];
  for (const migration of migrations) {
    const checksum = createHash('sha256').update(migration.sql).digest('hex');
    const previous = applied.get(migration.id);
    if (previous !== undefined) {
      if (previous !== checksum) {
        throw new Error(
          `Migration ${migration.id} changed after it was applied`,
        );
      }
      continue;
    }
    db.transaction((tx) => {
      tx.exec(migration.sql);
      tx.run(
        'INSERT INTO schema_migrations (id, checksum, applied_at) VALUES (?, ?, ?)',
        [migration.id, checksum, new Date().toISOString()],
      );
    });
    ran.push(migration.id);
  }
  return ran;
}
