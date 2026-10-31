import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SqlDatabase, SqlValue } from './database.js';

/** Opens a SQLite file (or `:memory:`) for the Node host and tests. Creates the parent directory of a file path. */
export function openSqliteDatabase(path: string): SqlDatabase {
  if (path !== ':memory:') {
    prepareDatabaseFiles(path);
  }
  const handle = new DatabaseSync(path);
  handle.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (path !== ':memory:') {
    handle.exec('PRAGMA journal_mode = WAL;');
  }
  return wrap(handle);
}

/**
 * Creates the directory and database files owner-only. Token digests and event
 * payloads must not be readable by other local users. SQLite keeps the mode of
 * files that already exist, so the WAL and shared-memory files are created here too.
 */
function prepareDatabaseFiles(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    closeSync(openSync(file, 'a', 0o600));
  }
}

function wrap(handle: DatabaseSync): SqlDatabase {
  const db: SqlDatabase = {
    exec: (sql) => handle.exec(sql),
    run: (sql, params = []) => handle.prepare(sql).run(...params),
    get: <T>(sql: string, params: readonly SqlValue[] = []) =>
      handle.prepare(sql).get(...params) as T | undefined,
    all: <T>(sql: string, params: readonly SqlValue[] = []) =>
      handle.prepare(sql).all(...params) as T[],
    transaction: <T>(fn: (tx: SqlDatabase) => T): T => {
      handle.exec('BEGIN IMMEDIATE');
      let result: T;
      try {
        result = fn(db);
        if (result instanceof Promise) {
          throw new TypeError('transaction callbacks must be synchronous');
        }
        handle.exec('COMMIT');
      } catch (error) {
        // Roll back only an open transaction, so a callback that already rolled
        // back does not replace the original error with "no transaction is active".
        if (handle.isTransaction) {
          handle.exec('ROLLBACK');
        }
        throw error;
      }
      return result;
    },
    close: () => handle.close(),
  };
  return db;
}
