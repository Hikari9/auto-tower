import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openSqliteDatabase } from '../../src/storage/sqlite.js';
import { tempDbPath } from '../helpers/tower.js';

describe('openSqliteDatabase', () => {
  it('creates a missing parent directory for a file path', () => {
    const path = join(
      tempDbPath().replace(/tower\.sqlite$/, ''),
      'nested',
      'deeper',
      'tower.sqlite',
    );

    const db = openSqliteDatabase(path);

    expect(existsSync(path)).toBe(true);
    expect(db.get<{ ok: number }>('SELECT 1 AS ok')?.ok).toBe(1);
    db.close();
  });
});
