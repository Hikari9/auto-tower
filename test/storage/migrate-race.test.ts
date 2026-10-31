import { describe, expect, it } from 'vitest';
import type { SqlDatabase } from '../../src/storage/database.js';
import { applyMigrations } from '../../src/storage/migrate.js';
import {
  defaultMigrationsDir,
  readMigrationFiles,
} from '../../src/storage/migration-files.js';
import { openSqliteDatabase } from '../../src/storage/sqlite.js';
import { tempDbPath } from '../helpers/tower.js';

describe('concurrent migration runners', () => {
  it('re-checks applied state under the write lock, after another connection commits', () => {
    const migrations = readMigrationFiles(defaultMigrationsDir());
    const path = tempDbPath();
    const rival = openSqliteDatabase(path);
    const second = openSqliteDatabase(path);
    let raced = false;
    // Another connection commits the migration after this one has decided to run it,
    // but before this one takes the write lock. Any check made before the lock is stale.
    const racing: SqlDatabase = {
      ...second,
      transaction: (fn) => {
        if (!raced) {
          raced = true;
          applyMigrations(rival, migrations);
        }
        return second.transaction(fn);
      },
    };

    expect(applyMigrations(racing, migrations)).toEqual([]);
    expect(raced).toBe(true);
    rival.close();
    second.close();
  });
});
