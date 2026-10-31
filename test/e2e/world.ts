import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../../src/api/app.js';
import { issueToken } from '../../src/auth/tokens.js';
import { type Core, createCore } from '../../src/core/index.js';
import type { CommandContext } from '../../src/core/service.js';
import type { Actor } from '../../src/core/types.js';
import { type Authority, createAuthority } from '../../src/decisions/index.js';
import {
  createFleet,
  createPool,
  defaultFleetConfig,
  type Fleet,
  type FleetConfig,
} from '../../src/fleet/index.js';
import {
  createIssueService,
  type IssueService,
} from '../../src/issues/index.js';
import type { SqlDatabase } from '../../src/storage/database.js';
import { applyMigrations } from '../../src/storage/migrate.js';
import {
  defaultMigrationsDir,
  readMigrationFiles,
} from '../../src/storage/migration-files.js';
import { openSqliteDatabase } from '../../src/storage/sqlite.js';
import { FakeClock } from '../core/helpers.js';
import { seedPrincipal, TEST_WORKSPACE } from '../helpers/tower.js';
import { FakeProvider } from '../issues/helpers.js';
import { appRequester, McpClient } from '../mcp/helpers.js';

export const WORLD_VERSION = '1.2.3';
export const WORLD_DIGEST = `sha256:${'a'.repeat(64)}`;

export interface WorldPrincipals {
  owner: { id: string; token: string; actor: Actor };
  cos: { id: string; token: string; actor: Actor };
}

export interface World {
  dir: string;
  dbPath: string;
  db: SqlDatabase;
  clock: FakeClock;
  config: FleetConfig;
  core: Core;
  authority: Authority;
  fleet: Fleet;
  issues: IssueService;
  github: FakeProvider;
  app: ReturnType<typeof createApp>;
  principals: WorldPrincipals;
  /** An initialized MCP session for a token. */
  mcp(token: string): Promise<McpClient>;
  /** One HTTP call into the app. */
  call(
    token: string | undefined,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: any }>;
  ownerCtx(): CommandContext;
  /** Closes the connection. The files stay for a restart. */
  close(): void;
}

export interface WorldOptions {
  /** Open this file instead of a new temporary one. Migrations are applied if it is empty. */
  dbPath?: string;
  /** Skip creating principals, for a database restored from a backup. */
  seedPrincipals?: boolean;
  /** Existing principal ids, to issue fresh tokens for after a restore. */
  existing?: { owner: string; cos: string };
  /** Skip applying migrations: the caller already did. */
  migrated?: boolean;
  clock?: FakeClock;
  github?: FakeProvider;
}

export function tempDir(label = 'tower-world-'): string {
  return mkdtempSync(join(tmpdir(), label));
}

/**
 * The whole control plane in one process over a SQLite file, with no network: the core, policy and
 * decisions, the fleet, the issue service over a fake GitHub, and the HTTP and MCP surfaces. A
 * "restart" is closing the connection and calling `createWorld` on the same file.
 */
export function createWorld(options: WorldOptions = {}): World {
  const dir = options.dbPath === undefined ? tempDir() : '';
  const dbPath = options.dbPath ?? join(dir, 'tower.sqlite');
  const db = openSqliteDatabase(dbPath);
  if (options.migrated !== true) {
    applyMigrations(db, readMigrationFiles(defaultMigrationsDir()));
  }
  const clock = options.clock ?? new FakeClock();
  const config: FleetConfig = {
    ...defaultFleetConfig(),
    supportedVersions: () => ({ min: '1.0.0', max: '1.9.9' }),
  };
  const github = options.github ?? new FakeProvider();
  const core = createCore({
    db,
    clock: clock.now,
    pool: createPool({ db, now: clock.now, config }),
  });
  const authority = createAuthority({
    db,
    guards: core.guards,
    clock: clock.now,
  });
  const fleet = createFleet({ db, core, now: clock.now, config });
  const issues = createIssueService({
    db,
    core,
    policy: authority.policy,
    providers: { github },
    clock: clock.now,
  });
  const app = createApp({
    db,
    now: clock.now,
    core,
    authority,
    fleet,
    issues,
    issueProviders: { github },
  });

  const principal = (
    kind: 'human' | 'chief_of_staff',
    existing: string | undefined,
  ) => {
    if (existing === undefined) {
      const seeded = seedPrincipal(db, { kind, name: kind });
      return { id: seeded.principalId, token: seeded.token };
    }
    const issued = issueToken(db, { principalId: existing, now: clock.now() });
    return { id: existing, token: issued.token };
  };
  const owner = principal('human', options.existing?.owner);
  const cos = principal('chief_of_staff', options.existing?.cos);
  const principals: WorldPrincipals = {
    owner: { ...owner, actor: { id: owner.id, kind: 'human' } },
    cos: { ...cos, actor: { id: cos.id, kind: 'chief_of_staff' } },
  };

  const call: World['call'] = async (token, method, path, rawBody) => {
    const body = method === 'GET' || method === 'HEAD' ? undefined : rawBody;
    const res = await app.request(path, {
      method,
      headers: {
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return {
      status: res.status,
      body: text === '' ? undefined : JSON.parse(text),
    };
  };

  return {
    dir,
    dbPath,
    db,
    clock,
    config,
    core,
    authority,
    fleet,
    issues,
    github,
    app,
    principals,
    async mcp(token) {
      const client = new McpClient(appRequester(app), token);
      const reply = await client.initialize();
      if (reply.status !== 200 || client.sessionId === undefined) {
        throw new Error(`MCP initialize failed: ${reply.status}`);
      }
      return client;
    },
    call,
    ownerCtx: () => ({
      workspaceId: TEST_WORKSPACE,
      actor: principals.owner.actor,
    }),
    close: () => db.close(),
  };
}
