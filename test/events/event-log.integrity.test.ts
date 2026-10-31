import { describe, expect, it } from 'vitest';
import {
  IdempotencyKeyReuseError,
  VersionConflictError,
} from '../../src/events/errors.js';
import {
  type AppendEventInput,
  createEventLog,
} from '../../src/events/event-log.js';
import { openSqliteDatabase } from '../../src/storage/sqlite.js';
import {
  openTestDatabase,
  seedPrincipal,
  TEST_WORKSPACE,
  tempDbPath,
} from '../helpers/tower.js';

const STREAM = 'mission:m1';

function input(
  actorId: string,
  overrides: Partial<AppendEventInput> = {},
): AppendEventInput {
  return {
    workspaceId: TEST_WORKSPACE,
    streamId: STREAM,
    expectedVersion: 0,
    type: 'mission.created',
    payload: { title: 'Ship it' },
    actorId,
    correlationId: 'corr_1',
    ...overrides,
  };
}

describe('stream isolation', () => {
  it('reads only the requested workspace, even for the same stream id', () => {
    const db = openTestDatabase();
    const a = seedPrincipal(db, { kind: 'human', workspaceId: 'ws_a' });
    const b = seedPrincipal(db, { kind: 'human', workspaceId: 'ws_b' });
    const log = createEventLog(db);
    log.append(
      input(a.principalId, { workspaceId: 'ws_a', payload: { who: 'a' } }),
    );
    log.append(
      input(b.principalId, { workspaceId: 'ws_b', payload: { who: 'b' } }),
    );

    expect(log.readStream('ws_a', STREAM).map((e) => e.payload)).toEqual([
      { who: 'a' },
    ]);
    expect(log.readStream('ws_b', STREAM).map((e) => e.payload)).toEqual([
      { who: 'b' },
    ]);
    expect(log.readStream('ws_empty', STREAM)).toEqual([]);
  });
});

describe('write lock', () => {
  it('takes the write lock when a transaction starts, so another writer cannot slip in', () => {
    const path = tempDbPath();
    const writerA = openTestDatabase(path);
    const writerB = openSqliteDatabase(path);
    writerB.exec('PRAGMA busy_timeout = 0');
    try {
      writerA.transaction((tx) => {
        tx.get('SELECT COUNT(*) AS n FROM events');
        expect(() =>
          writerB.run(
            "INSERT INTO workspaces (id, name, created_at) VALUES ('ws_x', 'x', 'now')",
          ),
        ).toThrow(/locked|busy/i);
      });
    } finally {
      writerA.close();
      writerB.close();
    }
  });
});

describe('append-only guards at the database level', () => {
  function seeded() {
    const db = openTestDatabase();
    const principal = seedPrincipal(db, { kind: 'human' });
    const first = createEventLog(db).append(
      input(principal.principalId, { idempotencyKey: 'k1' }),
    );
    return { db, principal, first };
  }

  it('rejects UPDATE and DELETE on idempotency keys', () => {
    const { db } = seeded();

    expect(() =>
      db.run('UPDATE idempotency_keys SET request_hash = ?', ['tampered']),
    ).toThrow(/append-only/);
    expect(() => db.run('DELETE FROM idempotency_keys')).toThrow(/append-only/);
    expect(
      db.get<{ request_hash: string }>(
        'SELECT request_hash FROM idempotency_keys',
      )?.request_hash,
    ).not.toBe('tampered');
  });

  it('rejects INSERT OR REPLACE over an existing event, which skips delete triggers', () => {
    const { db, first } = seeded();

    expect(() =>
      db.run(
        `INSERT OR REPLACE INTO events (seq, workspace_id, stream_id, version, type, payload_json, actor_id, correlation_id, recorded_at)
         VALUES (?, ?, ?, 1, 'tampered', '{}', ?, 'c', 'now')`,
        [first.event.seq, TEST_WORKSPACE, STREAM, first.event.actorId],
      ),
    ).toThrow(/append-only/);
    expect(db.get<{ type: string }>('SELECT type FROM events')?.type).toBe(
      'mission.created',
    );
  });

  it('rejects a second row for the same stream version even when inserted directly', () => {
    const { db, principal } = seeded();

    expect(() =>
      db.run(
        `INSERT INTO events (workspace_id, stream_id, version, type, payload_json, actor_id, correlation_id, recorded_at)
         VALUES (?, ?, 1, 'duplicate', '{}', ?, 'c', 'now')`,
        [TEST_WORKSPACE, STREAM, principal.principalId],
      ),
    ).toThrow();
  });

  it('rejects INSERT OR REPLACE over an idempotency key', () => {
    const { db, principal, first } = seeded();

    expect(() =>
      db.run(
        `INSERT OR REPLACE INTO idempotency_keys (workspace_id, principal_id, idempotency_key, request_hash, event_seq, created_at)
         VALUES (?, ?, 'k1', 'forged', ?, 'now')`,
        [TEST_WORKSPACE, principal.principalId, first.event.seq],
      ),
    ).toThrow(/append-only/);
    expect(
      db.get<{ request_hash: string }>(
        'SELECT request_hash FROM idempotency_keys',
      )?.request_hash,
    ).not.toBe('forged');
  });
});

describe('expected version', () => {
  it('conflicts when the caller expects a version ahead of the stream', () => {
    const db = openTestDatabase();
    const principal = seedPrincipal(db, { kind: 'human' });
    const log = createEventLog(db);

    expect(() =>
      log.append(input(principal.principalId, { expectedVersion: 5 })),
    ).toThrow(VersionConflictError);
    expect(log.readStream(TEST_WORKSPACE, STREAM)).toEqual([]);
  });
});

describe('idempotency request hashing', () => {
  const base = { idempotencyKey: 'same-key', payload: { a: 1 } };

  it.each([
    ['payload', { payload: { a: 2 } }],
    ['type', { type: 'mission.other' }],
    ['streamId', { streamId: 'mission:m2' }],
    ['expectedVersion', { expectedVersion: 1 }],
    ['correlationId', { correlationId: 'corr_2' }],
    ['policyRefs', { policyRefs: ['policy:v9'] }],
    ['evidenceRefs', { evidenceRefs: ['ev_9'] }],
  ])('rejects a replay that differs in %s', (_field, change) => {
    const db = openTestDatabase();
    const principal = seedPrincipal(db, { kind: 'human' });
    const log = createEventLog(db);
    log.append(input(principal.principalId, base));

    expect(() =>
      log.append(input(principal.principalId, { ...base, ...change })),
    ).toThrow(IdempotencyKeyReuseError);
  });

  it('treats reordered object keys in the payload as the same request', () => {
    const db = openTestDatabase();
    const principal = seedPrincipal(db, { kind: 'human' });
    const log = createEventLog(db);
    const original = log.append(
      input(principal.principalId, {
        idempotencyKey: 'ord',
        payload: { a: 1, b: 2 },
      }),
    );

    const replay = log.append(
      input(principal.principalId, {
        idempotencyKey: 'ord',
        payload: { b: 2, a: 1 },
      }),
    );

    expect(replay.replayed).toBe(true);
    expect(replay.event.seq).toBe(original.event.seq);
  });
});

describe('actor and key scoping', () => {
  it('refuses an actor from another workspace, enforced by a composite foreign key', () => {
    const db = openTestDatabase();
    const owner = seedPrincipal(db, { kind: 'human', workspaceId: 'ws_a' });
    seedPrincipal(db, { kind: 'human', workspaceId: 'ws_b' });
    const log = createEventLog(db);

    expect(() =>
      log.append(input(owner.principalId, { workspaceId: 'ws_b' })),
    ).toThrow(/FOREIGN KEY/);
    expect(log.readStream('ws_b', STREAM)).toEqual([]);
  });

  it.each([
    'workspaceId',
    'streamId',
    'type',
    'actorId',
    'correlationId',
  ] as const)('rejects an empty %s', (field) => {
    const db = openTestDatabase();
    const principal = seedPrincipal(db, { kind: 'human' });

    expect(() =>
      createEventLog(db).append(
        input(principal.principalId, { [field]: '   ' }),
      ),
    ).toThrow(RangeError);
  });

  it('rejects an empty idempotency key rather than storing it', () => {
    const db = openTestDatabase();
    const principal = seedPrincipal(db, { kind: 'human' });

    expect(() =>
      createEventLog(db).append(
        input(principal.principalId, { idempotencyKey: '' }),
      ),
    ).toThrow(RangeError);
    expect(db.get('SELECT 1 AS one FROM idempotency_keys')).toBeUndefined();
  });
});

describe('foreign keys', () => {
  it('enforces foreign keys so a token cannot reference a missing principal', () => {
    const db = openTestDatabase();

    expect(
      db.get<{ foreign_keys: number }>('PRAGMA foreign_keys')?.foreign_keys,
    ).toBe(1);
    expect(() =>
      db.run(
        `INSERT INTO api_tokens (id, workspace_id, principal_id, token_hash, scopes_json, created_at)
         VALUES ('tok_x', ?, 'prn_missing', 'hash', '[]', 'now')`,
        [TEST_WORKSPACE],
      ),
    ).toThrow(/FOREIGN KEY/);
  });
});
