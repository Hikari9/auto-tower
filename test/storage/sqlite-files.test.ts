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

describe('database file permissions', () => {
  it('creates the directory and the database, WAL and shared-memory files owner-only', () => {
    const path = join(dirname(tempDbPath()), 'private', 'tower.sqlite');
    const db = openSqliteDatabase(path);
    db.exec('CREATE TABLE probe (x INTEGER)');
    db.run('INSERT INTO probe (x) VALUES (1)');

    expect(mode(dirname(path))).toBe(0o700);
    expect(mode(path)).toBe(0o600);
    for (const sibling of [`${path}-wal`, `${path}-shm`]) {
      expect(existsSync(sibling), sibling).toBe(true);
      expect(mode(sibling), sibling).toBe(0o600);
    }
    db.close();
  });

  it('tightens a pre-existing world-readable database file to owner-only', () => {
    const path = tempDbPath();
    writeFileSync(path, '');
    chmodSync(path, 0o644);
    expect(mode(path)).toBe(0o644);

    openSqliteDatabase(path).close();

    expect(mode(path)).toBe(0o600);
  });

  it('refuses a sidecar that is a symbolic link instead of following it', () => {
    const path = tempDbPath();
    const target = join(dirname(path), 'elsewhere');
    writeFileSync(target, '');
    chmodSync(target, 0o644);
    symlinkSync(target, `${path}-wal`);

    expect(() => openSqliteDatabase(path)).toThrow(/symbolic link/);
    expect(lstatSync(`${path}-wal`).isSymbolicLink()).toBe(true);
    expect(mode(target)).toBe(0o644);
  });
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
