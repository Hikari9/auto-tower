import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { readSweepInterval, startHost } from '../../src/hosting/host.js';
import worker from '../../src/hosting/worker.js';
import {
  DEFAULT_SWEEP_INTERVAL_MS,
  guardStorage,
} from '../../src/ops/index.js';
import { FakeClock, mission } from '../core/helpers.js';
import { createWorld, WORLD_DIGEST, WORLD_VERSION } from '../e2e/world.js';
import {
  openTestDatabase,
  seedPrincipal,
  tempDbPath,
} from '../helpers/tower.js';
import { appRequester, key, McpClient } from '../mcp/helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TOWER_SWEEP_INTERVAL_MS', () => {
  it('defaults when unset or empty, turns off at 0, and ignores nonsense rather than turning off', () => {
    expect(readSweepInterval({})).toBe(DEFAULT_SWEEP_INTERVAL_MS);
    expect(readSweepInterval({ TOWER_SWEEP_INTERVAL_MS: '' })).toBe(
      DEFAULT_SWEEP_INTERVAL_MS,
    );
    expect(readSweepInterval({ TOWER_SWEEP_INTERVAL_MS: '0' })).toBe(0);
    expect(readSweepInterval({ TOWER_SWEEP_INTERVAL_MS: '250' })).toBe(250);
    expect(readSweepInterval({ TOWER_SWEEP_INTERVAL_MS: '10' })).toBe(10);
    expect(readSweepInterval({ TOWER_SWEEP_INTERVAL_MS: '2147483647' })).toBe(
      2147483647,
    );
    // Over 2^31-1 ms a Node timer fires every millisecond, and under 10 ms a sweep starves the loop.
    for (const bad of [
      'abc',
      '-5',
      '1.5',
      'NaN',
      ' ',
      '2592000000',
      '2147483648',
      '1',
      '9',
    ]) {
      expect(readSweepInterval({ TOWER_SWEEP_INTERVAL_MS: bad }), bad).toBe(
        DEFAULT_SWEEP_INTERVAL_MS,
      );
    }
  });
});

async function listening(server: ReturnType<typeof startHost>) {
  await new Promise<void>((resolve) =>
    server.once('listening', () => resolve()),
  );
}

describe('the Node server sweeps with no runner poll', () => {
  it('dispatches ready work to a live runner on its own', async () => {
    // Heartbeats are stamped with the real clock the server will use.
    const clock = new FakeClock(Date.now());
    const world = createWorld({ clock });
    const enrolled = await world.call(
      world.principals.owner.token,
      'POST',
      '/runners/enrollments',
      {
        name: 'r',
        version: WORLD_VERSION,
        buildDigest: WORLD_DIGEST,
        allowedScopes: ['*'],
        maxConcurrent: 1,
      },
    );
    const registered = await world.call(
      enrolled.body.enrollment.token,
      'POST',
      '/runners/register',
      {
        version: WORLD_VERSION,
        buildDigest: WORLD_DIGEST,
        capabilities: [],
      },
    );
    const poll = await world.call(
      registered.body.token,
      'POST',
      '/runners/claims',
      {
        version: WORLD_VERSION,
        buildDigest: WORLD_DIGEST,
      },
    );
    expect(poll.status).toBe(200);

    const { missions } = world.core;
    const created = missions.createMission(world.ownerCtx(), mission()).mission;
    let state = missions.transitionMission(
      world.ownerCtx(),
      created.id,
      created.version,
      'ready',
      null,
    ).mission;
    state = missions.addPacket(world.ownerCtx(), created.id, state.version, {
      title: 'p',
      instructions: 'do',
      scope: ['repo:app'],
      required: true,
      dependsOn: [],
    }).mission;
    missions.authorizePacket(
      world.ownerCtx(),
      created.id,
      state.version,
      state.packets[0]?.id as string,
      [],
    );
    expect(world.db.all('SELECT id FROM execution_attempts')).toEqual([]);
    const path = world.dbPath;
    world.close();

    const server = startHost(
      { TOWER_DB_PATH: path, PORT: '0', TOWER_SWEEP_INTERVAL_MS: '25' },
      () => {},
    );
    try {
      await listening(server);
      // No runner polls from here on. Only the server's own timer can dispatch.
      const { openSqliteDatabase } = await import(
        '../../src/storage/sqlite.js'
      );
      const reader = openSqliteDatabase(path);
      try {
        const deadline = Date.now() + 5000;
        let attempts = 0;
        while (Date.now() < deadline && attempts === 0) {
          attempts = reader.all('SELECT id FROM execution_attempts').length;
          if (attempts === 0) {
            await new Promise((r) => setTimeout(r, 25));
          }
        }
        expect(attempts).toBe(1);
      } finally {
        reader.close();
      }
    } finally {
      server.close();
    }
  });

  it('does nothing when the sweep is off, and says so in its log line', async () => {
    const lines: string[] = [];
    const server = startHost(
      { TOWER_DB_PATH: tempDbPath(), PORT: '0', TOWER_SWEEP_INTERVAL_MS: '0' },
      (l) => lines.push(l),
    );
    try {
      await listening(server);
      expect(lines.join('\n')).toMatch(/sweep off/);
    } finally {
      server.close();
    }
    const lines2: string[] = [];
    const on = startHost({ TOWER_DB_PATH: tempDbPath(), PORT: '0' }, (l) =>
      lines2.push(l),
    );
    try {
      await listening(on);
      expect(lines2.join('\n')).toMatch(/sweep every 15000 ms/);
    } finally {
      on.close();
    }
  });

  it('stops its timer when the server closes', async () => {
    const set = vi.spyOn(globalThis, 'setInterval');
    const clear = vi.spyOn(globalThis, 'clearInterval');
    const server = startHost(
      {
        TOWER_DB_PATH: tempDbPath(),
        PORT: '0',
        TOWER_SWEEP_INTERVAL_MS: '1000',
      },
      () => {},
    );
    await listening(server);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // The sweep's own timer is the one that was cleared, not some other interval in the process.
    const sweepTimer = set.mock.results.find(
      (r) => (r.value as NodeJS.Timeout).hasRef?.() === false,
    )?.value;
    expect(sweepTimer).toBeDefined();
    expect(clear.mock.calls.map((c) => c[0])).toContain(sweepTimer);
  });
});

describe('the quota guard on the host database', () => {
  it('lets a person clear a tripped guard over MCP, and nobody else', async () => {
    const raw = openTestDatabase();
    const full = { on: false };
    const wrapped = {
      exec: (sql: string) => raw.exec(sql),
      run: (
        sql: string,
        params?: readonly (string | number | bigint | null)[],
      ) => {
        if (full.on && /^\s*(insert|update|delete)/i.test(sql)) {
          throw Object.assign(new Error('database or disk is full'), {
            errcode: 13,
          });
        }
        return raw.run(sql, params);
      },
      get: raw.get.bind(raw),
      all: raw.all.bind(raw),
      transaction: <T>(fn: (tx: typeof raw) => T): T =>
        raw.transaction((tx) => fn(tx === raw ? (wrapped as typeof raw) : tx)),
      close: () => raw.close(),
    } as typeof raw;
    const db = guardStorage(wrapped);
    const owner = seedPrincipal(raw, { kind: 'human', name: 'owner' });
    const cos = seedPrincipal(raw, { kind: 'chief_of_staff', name: 'cos' });
    const app = createApp({ db });
    const human = new McpClient(appRequester(app), owner.token);
    const chief = new McpClient(appRequester(app), cos.token);
    await human.initialize();
    await chief.initialize();

    full.on = true;
    const refused = await human.call('create_mission', {
      title: 'x',
      intent: 'i',
      outcome: 'o',
      idempotencyKey: key(),
    });
    expect(refused.data.error.code).toBe('storage_quota_exhausted');
    expect(db.quota.tripped).toBe(true);

    full.on = false;
    expect(
      (
        await chief.call('reset_storage_guard', {
          confirm: true,
          idempotencyKey: key(),
        })
      ).status,
    ).toBe(403);
    expect(db.quota.tripped).toBe(true);
    const cleared = await human.ok('reset_storage_guard', {
      confirm: true,
      idempotencyKey: key(),
    });
    expect(cleared).toEqual({ guarded: true, tripped: false });
    expect(
      (
        await human.ok('create_mission', {
          title: 'y',
          intent: 'i',
          outcome: 'o',
          idempotencyKey: key(),
        })
      ).mission.id,
    ).toBeDefined();
    expect((await human.ok('read_health', {})).health.status).toBe('ok');
  });

  it('answers a retried reset with the guard as it is now, without clearing it again', async () => {
    const raw = openTestDatabase();
    const full = { on: false };
    const wrapped = {
      ...raw,
      run: (
        sql: string,
        params?: readonly (string | number | bigint | null)[],
      ) => {
        if (full.on && /^\s*(insert|update|delete)/i.test(sql)) {
          throw Object.assign(new Error('database or disk is full'), {
            errcode: 13,
          });
        }
        return raw.run(sql, params);
      },
      transaction: <T>(fn: (tx: typeof raw) => T): T =>
        raw.transaction((tx) => fn(tx === raw ? (wrapped as typeof raw) : tx)),
    } as typeof raw;
    const db = guardStorage(wrapped);
    const owner = seedPrincipal(raw, { kind: 'human' });
    const human = new McpClient(appRequester(createApp({ db })), owner.token);
    await human.initialize();
    const resetKey = key('reset');
    expect(
      await human.ok('reset_storage_guard', {
        confirm: true,
        idempotencyKey: resetKey,
      }),
    ).toEqual({
      guarded: true,
      tripped: false,
    });
    // The store fills and the guard trips again. A late retry of the old reset must not clear it.
    full.on = true;
    await human.call('create_mission', {
      title: 'x',
      intent: 'i',
      outcome: 'o',
      idempotencyKey: key(),
    });
    expect(db.quota.tripped).toBe(true);
    const late = await human.call('reset_storage_guard', {
      confirm: true,
      idempotencyKey: resetKey,
    });
    expect(late.meta?.['tower/replayed']).toBe(true);
    expect(late.data).toEqual({ guarded: true, tripped: true });
    expect(db.quota.tripped).toBe(true);
  });

  it('reports an unguarded database as such', async () => {
    const raw = openTestDatabase();
    const owner = seedPrincipal(raw, { kind: 'human' });
    const human = new McpClient(
      appRequester(createApp({ db: raw })),
      owner.token,
    );
    await human.initialize();
    expect(
      await human.ok('reset_storage_guard', {
        confirm: true,
        idempotencyKey: key(),
      }),
    ).toEqual({
      guarded: false,
      tripped: false,
    });
  });
});

describe('the Workers cron trigger', () => {
  it('runs the sweep the host supplies, once per trigger', async () => {
    const SWEEP = vi.fn();
    await worker.scheduled({}, { SWEEP });
    expect(SWEEP).toHaveBeenCalledTimes(1);
    await worker.scheduled(
      {},
      {
        SWEEP: async () => {
          SWEEP();
        },
      },
    );
    expect(SWEEP).toHaveBeenCalledTimes(2);
  });

  it('does nothing, and does not fail, with no store bound', async () => {
    await expect(worker.scheduled()).resolves.toBeUndefined();
    await expect(worker.scheduled({}, {})).resolves.toBeUndefined();
  });

  it('lets a failing sweep fail the trigger, so Cloudflare records it', async () => {
    await expect(
      worker.scheduled(
        {},
        {
          SWEEP: () => {
            throw new Error('boom');
          },
        },
      ),
    ).rejects.toThrow('boom');
  });

  it('is declared in wrangler.toml', () => {
    const toml = readFileSync(
      new URL('../../wrangler.toml', import.meta.url),
      'utf8',
    );
    expect(toml).toMatch(/\[triggers\]\s*\ncrons = \["\* \* \* \* \*"\]/);
  });
});
