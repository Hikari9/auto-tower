import { describe, expect, it } from 'vitest';
import { applyMigrations } from '../../src/storage/migrate.js';
import {
  defaultMigrationsDir,
  readMigrationFiles,
} from '../../src/storage/migration-files.js';
import { openSqliteDatabase } from '../../src/storage/sqlite.js';
import { tempDbPath } from '../helpers/tower.js';

describe('concurrent migration runners', () => {
  it('does not re-run a migration that another connection committed after this one took its snapshot', () => {
    const migrations = readMigrationFiles(defaultMigrationsDir());
    const path = tempDbPath();
    applyMigrations(openSqliteDatabase(path), migrations);

    const second = openSqliteDatabase(path);
    // The second connection reads a stale snapshot in which nothing is applied yet.
    const stale = {
      ...second,
      all: <T>(sql: string, params?: Parameters<typeof second.all>[1]) =>
        sql.includes('schema_migrations')
          ? ([] as T[])
          : second.all<T>(sql, params),
    };

    expect(applyMigrations(stale, migrations)).toEqual([]);
    second.close();
  });
});
