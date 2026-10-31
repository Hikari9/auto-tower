import { DatabaseSync } from 'node:sqlite';
import type { SqlDatabase, SqlValue } from './database.js';

/** Opens a SQLite file (or `:memory:`) for the Node host and tests. */
export function openSqliteDatabase(path: string): SqlDatabase {
  const handle = new DatabaseSync(path);
  handle.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (path !== ':memory:') {
    handle.exec('PRAGMA journal_mode = WAL;');
  }
  return wrap(handle);
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
      try {
        const result = fn(db);
        handle.exec('COMMIT');
        return result;
      } catch (error) {
        handle.exec('ROLLBACK');
        throw error;
      }
    },
    close: () => handle.close(),
  };
  return db;
}
