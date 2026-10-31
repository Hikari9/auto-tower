import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPrincipal,
  ensureWorkspace,
  type PrincipalKind,
  type Scope,
} from '../../src/auth/principals.js';
import { issueToken } from '../../src/auth/tokens.js';
import type { SqlDatabase } from '../../src/storage/database.js';
import { applyMigrations } from '../../src/storage/migrate.js';
import {
  defaultMigrationsDir,
  readMigrationFiles,
} from '../../src/storage/migration-files.js';
import { openSqliteDatabase } from '../../src/storage/sqlite.js';

export const TEST_WORKSPACE = 'ws_test';

/** Fresh database with every migration applied. Pass a file path to share it across connections. */
export function openTestDatabase(path = ':memory:'): SqlDatabase {
  const db = openSqliteDatabase(path);
  applyMigrations(db, readMigrationFiles(defaultMigrationsDir()));
  return db;
}

export function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'tower-test-')), 'tower.sqlite');
}

export interface SeededPrincipal {
  principalId: string;
  token: string;
  tokenId: string;
}

export function seedPrincipal(
  db: SqlDatabase,
  options: {
    kind: PrincipalKind;
    workspaceId?: string;
    name?: string;
    scopes?: readonly Scope[];
    expiresAt?: Date;
    now?: Date;
  },
): SeededPrincipal {
  const workspaceId = options.workspaceId ?? TEST_WORKSPACE;
  ensureWorkspace(db, workspaceId, workspaceId);
  const principal = createPrincipal(db, {
    workspaceId,
    kind: options.kind,
    name: options.name ?? options.kind,
  });
  const issued = issueToken(db, {
    principalId: principal.id,
    scopes: options.scopes,
    expiresAt: options.expiresAt,
    now: options.now,
  });
  return { principalId: principal.id, token: issued.token, tokenId: issued.id };
}
