import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
} from 'node:fs';
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
 * Keeps the database owner-only: token digests and event payloads must not be
 * readable by other local users, and another user must not be able to swap a
 * file or link underneath it. The directory must not be writable by others,
 * which is why a pre-existing shared directory such as /tmp is refused.
 */
function prepareDatabaseFiles(path: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dirStat = lstatSync(dir);
  if (!dirStat.isDirectory()) {
    throw new Error(`Refusing database directory ${dir}: not a directory`);
  }
  if ((dirStat.mode & 0o022) !== 0) {
    throw new Error(
      `Refusing database directory ${dir}: writable by other users`,
    );
  }
  for (const file of [path, `${path}-wal`, `${path}-shm`]) {
    openOwnerOnly(file);
  }
}

/** Opens without following links, then sets the mode on the descriptor, so no path is re-resolved. */
function openOwnerOnly(file: string): void {
  let fd: number;
  try {
    fd = openSync(
      file,
      constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch (error) {
    if (hasErrno(error, 'ELOOP')) {
      throw new Error(`Refusing to open ${file}: it is a symbolic link`);
    }
    throw error;
  }
  try {
    const st = fstatSync(fd);
    const uid = process.getuid?.();
    if (!st.isFile() || (uid !== undefined && st.uid !== uid)) {
      throw new Error(
        `Refusing to open ${file}: not a regular file owned by this user`,
      );
    }
    fchmodSync(fd, 0o600);
  } catch (error) {
    if (hasErrno(error, 'EPERM') || hasErrno(error, 'ENOTSUP')) {
      throw new Error(`Cannot make ${file} owner-only on this filesystem`);
    }
    throw error;
  } finally {
    closeSync(fd);
  }
}

function hasErrno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
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
    readTransaction: <T>(fn: (tx: SqlDatabase) => T): T => {
      // A deferred transaction: under WAL the first read pins a snapshot and writers are not blocked.
      handle.exec('BEGIN');
      try {
        const result = fn(db);
        if (result instanceof Promise) {
          throw new TypeError('transaction callbacks must be synchronous');
        }
        return result;
      } finally {
        if (handle.isTransaction) {
          handle.exec('ROLLBACK');
        }
      }
    },
    close: () => handle.close(),
  };
  return db;
}
