import { describe, expect, it } from 'vitest';
import { applyMigrations, type Migration } from '../../src/storage/migrate.js';
import {
  defaultMigrationsDir,
  readMigrationFiles,
} from '../../src/storage/migration-files.js';
import { openSqliteDatabase } from '../../src/storage/sqlite.js';
import { openTestDatabase } from '../helpers/tower.js';

describe('migrations', () => {
  it('applies each migration once and skips them on re-run', () => {
    const db = openSqliteDatabase(':memory:');
    const migrations = readMigrationFiles(defaultMigrationsDir());
    expect(applyMigrations(db, migrations)).toEqual(['0001_initial']);
    expect(applyMigrations(db, migrations)).toEqual([]);
  });

  it('refuses to run when an applied migration has been edited', () => {
    const db = openSqliteDatabase(':memory:');
    applyMigrations(db, [
      { id: '0001_x', sql: 'CREATE TABLE a (id INTEGER);' },
    ]);
    expect(() =>
      applyMigrations(db, [
        { id: '0001_x', sql: 'CREATE TABLE a (id INTEGER, extra TEXT);' },
      ]),
    ).toThrow(/changed after it was applied/);
  });

  it('rolls back a failing migration completely', () => {
    const db = openSqliteDatabase(':memory:');
    const broken: Migration = {
      id: '0001_broken',
      sql: 'CREATE TABLE half_done (id INTEGER); INSERT INTO missing_table VALUES (1);',
    };
    expect(() => applyMigrations(db, [broken])).toThrow();
    expect(
      db.get("SELECT name FROM sqlite_master WHERE name = 'half_done'"),
    ).toBeUndefined();
    expect(db.all('SELECT id FROM schema_migrations')).toEqual([]);
  });

  it('gives every tenant-owned table an explicit workspace_id column', () => {
    const db = openTestDatabase();
    for (const table of [
      'principals',
      'api_tokens',
      'events',
      'idempotency_keys',
    ]) {
      const columns = db
        .all<{ name: string }>(`PRAGMA table_info(${table})`)
        .map((c) => c.name);
      expect(columns, table).toContain('workspace_id');
    }
  });
});

describe('transactions', () => {
  it('rolls back every write in a transaction that throws', () => {
    const db = openTestDatabase();
    db.run('INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)', [
      'ws_a',
      'a',
      'now',
    ]);
    expect(() =>
      db.transaction((tx) => {
        tx.run(
          'INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)',
          ['ws_b', 'b', 'now'],
        );
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(db.all('SELECT id FROM workspaces ORDER BY id')).toEqual([
      { id: 'ws_a' },
    ]);
  });
});
