import { existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openSqliteDatabase } from '../../src/storage/sqlite.js';
import { tempDbPath } from '../helpers/tower.js';

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

  it('rejects an async callback instead of committing before it settles', () => {
    const db = openSqliteDatabase(':memory:');

    expect(() => db.transaction(async () => 1)).toThrow(TypeError);
  });
});
