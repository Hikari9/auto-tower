import {
  chmodSync,
  existsSync,
  lstatSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openSqliteDatabase } from '../../src/storage/sqlite.js';
import { openTestDatabase, tempDbPath } from '../helpers/tower.js';

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

/** The main database file and both sidecars SQLite uses in WAL mode. */
function databaseFiles(path: string): string[] {
  return [path, `${path}-wal`, `${path}-shm`];
}

describe('database file permissions', () => {
  it('creates the directory and the database, WAL and shared-memory files owner-only', () => {
    const path = join(dirname(tempDbPath()), 'private', 'tower.sqlite');
    const db = openSqliteDatabase(path);
    db.exec('CREATE TABLE probe (x INTEGER)');
    db.run('INSERT INTO probe (x) VALUES (1)');

    expect(mode(dirname(path))).toBe(0o700);
    for (const file of databaseFiles(path)) {
      expect(existsSync(file), file).toBe(true);
      expect(mode(file), file).toBe(0o600);
    }
    db.close();
  });

  it.each([0, 1, 2])(
    'tightens a pre-existing world-readable database file %i to owner-only',
    (index) => {
      const path = tempDbPath();
      const file = databaseFiles(path)[index] ?? path;
      writeFileSync(file, '');
      chmodSync(file, 0o644);
      expect(mode(file)).toBe(0o644);

      openSqliteDatabase(path).close();

      expect(mode(file)).toBe(0o600);
    },
  );

  it('leaves a pre-existing directory at its own mode', () => {
    const path = tempDbPath();
    chmodSync(dirname(path), 0o755);

    openSqliteDatabase(path).close();

    expect(mode(dirname(path))).toBe(0o755);
  });

  it('refuses a database directory that other users can write to', () => {
    const path = tempDbPath();
    chmodSync(dirname(path), 0o777);

    expect(() => openSqliteDatabase(path)).toThrow(/writable by other users/);
  });

  it.each([0, 1, 2])(
    'refuses a symbolic link at database file %i instead of following it',
    (index) => {
      const path = tempDbPath();
      const target = join(dirname(path), 'elsewhere');
      writeFileSync(target, '');
      chmodSync(target, 0o644);
      const link = databaseFiles(path)[index] ?? path;
      symlinkSync(target, link);

      expect(() => openSqliteDatabase(path)).toThrow(/symbolic link/);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(mode(target)).toBe(0o644);
    },
  );
});

describe('transaction error handling', () => {
  it('reports the callback error when the callback already rolled back', () => {
    const db = openSqliteDatabase(':memory:');

    expect(() =>
      db.transaction((tx) => {
        tx.exec('ROLLBACK');
        throw new Error('boom');
      }),
    ).toThrow('boom');
  });

  it('rejects an async callback and rolls back the writes it started', () => {
    const db = openTestDatabase(tempDbPath());

    expect(() =>
      db.transaction(async (tx) => {
        tx.run(
          "INSERT INTO workspaces (id, name, created_at) VALUES ('ws_async', 'a', 'now')",
        );
        return 1;
      }),
    ).toThrow(TypeError);

    expect(
      db.get("SELECT id FROM workspaces WHERE id = 'ws_async'"),
    ).toBeUndefined();
    // The connection is not left inside an open transaction.
    expect(() => db.exec('BEGIN IMMEDIATE; COMMIT;')).not.toThrow();
    db.close();
  });
});
