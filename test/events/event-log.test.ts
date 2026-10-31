import { describe, expect, it } from 'vitest';
import { ensureWorkspace } from '../../src/auth/principals.js';
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

describe('event log', () => {
  it('appends in version order and records actor, correlation and refs', () => {
    const db = openTestDatabase();
    const { principalId } = seedPrincipal(db, { kind: 'human' });
    const log = createEventLog(db);

    const first = log.append(
      input(principalId, { policyRefs: ['policy:v3'], evidenceRefs: ['ev_1'] }),
    );
    const second = log.append(
      input(principalId, {
        expectedVersion: 1,
        type: 'mission.updated',
        payload: { n: 2 },
      }),
    );

    expect(first.replayed).toBe(false);
    expect(first.event).toMatchObject({
      version: 1,
      type: 'mission.created',
      payload: { title: 'Ship it' },
      actorId: principalId,
      correlationId: 'corr_1',
      policyRefs: ['policy:v3'],
      evidenceRefs: ['ev_1'],
    });
    expect(second.event.version).toBe(2);
    expect(
      log.readStream(TEST_WORKSPACE, STREAM).map((e) => e.version),
    ).toEqual([1, 2]);
  });

  it('rejects an append whose expected version is stale and writes nothing', () => {
    const db = openTestDatabase();
    const { principalId } = seedPrincipal(db, { kind: 'human' });
    const log = createEventLog(db);
    log.append(input(principalId));

    expect(() => log.append(input(principalId))).toThrow(VersionConflictError);
    expect(log.readStream(TEST_WORKSPACE, STREAM)).toHaveLength(1);
  });

  it('detects a concurrent append from a second connection', () => {
    const path = tempDbPath();
    const dbA = openTestDatabase(path);
    const dbB = openSqliteDatabase(path);
    const { principalId } = seedPrincipal(dbA, { kind: 'human' });

    // Both writers read the stream at version 0 before either appends.
    const logA = createEventLog(dbA);
    const logB = createEventLog(dbB);
    logA.append(input(principalId));

    let conflict: unknown;
    try {
      logB.append(input(principalId, { payload: { title: 'Racing writer' } }));
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(VersionConflictError);
    expect(conflict).toMatchObject({ expectedVersion: 0, actualVersion: 1 });
    expect(logA.readStream(TEST_WORKSPACE, STREAM)).toHaveLength(1);
    dbA.close();
    dbB.close();
  });

  it('replays a duplicate idempotent call and returns the original event', () => {
    const db = openTestDatabase();
    const { principalId } = seedPrincipal(db, { kind: 'human' });
    const log = createEventLog(db);
    const original = log.append(
      input(principalId, { idempotencyKey: 'create-m1' }),
    );

    const replay = log.append(
      input(principalId, { idempotencyKey: 'create-m1' }),
    );

    expect(replay.replayed).toBe(true);
    expect(replay.event).toEqual(original.event);
    expect(log.readStream(TEST_WORKSPACE, STREAM)).toHaveLength(1);
  });

  it('rejects a reused idempotency key carrying a different request', () => {
    const db = openTestDatabase();
    const { principalId } = seedPrincipal(db, { kind: 'human' });
    const log = createEventLog(db);
    log.append(input(principalId, { idempotencyKey: 'create-m1' }));

    expect(() =>
      log.append(
        input(principalId, {
          idempotencyKey: 'create-m1',
          payload: { title: 'Different' },
        }),
      ),
    ).toThrow(IdempotencyKeyReuseError);
    expect(log.readStream(TEST_WORKSPACE, STREAM)).toHaveLength(1);
  });

  it('scopes idempotency keys to the calling principal', () => {
    const db = openTestDatabase();
    const alice = seedPrincipal(db, { kind: 'human', name: 'alice' });
    const bob = seedPrincipal(db, { kind: 'chief_of_staff', name: 'bob' });
    const log = createEventLog(db);
    log.append(input(alice.principalId, { idempotencyKey: 'shared-key' }));

    const bobWrite = log.append(
      input(bob.principalId, {
        expectedVersion: 1,
        idempotencyKey: 'shared-key',
        payload: {},
      }),
    );

    expect(bobWrite.replayed).toBe(false);
    expect(bobWrite.event.version).toBe(2);
  });

  it('keeps version numbering separate per workspace', () => {
    const db = openTestDatabase();
    const { principalId } = seedPrincipal(db, { kind: 'human' });
    ensureWorkspace(db, 'ws_other', 'other');
    const log = createEventLog(db);
    log.append(input(principalId));

    const other = log.append(input(principalId, { workspaceId: 'ws_other' }));

    expect(other.event.version).toBe(1);
  });

  it('refuses a negative or fractional expected version', () => {
    const db = openTestDatabase();
    const { principalId } = seedPrincipal(db, { kind: 'human' });
    const log = createEventLog(db);

    expect(() =>
      log.append(input(principalId, { expectedVersion: -1 })),
    ).toThrow(RangeError);
    expect(() =>
      log.append(input(principalId, { expectedVersion: 0.5 })),
    ).toThrow(RangeError);
  });

  it('is append-only at the database level', () => {
    const db = openTestDatabase();
    const { principalId } = seedPrincipal(db, { kind: 'human' });
    createEventLog(db).append(input(principalId));

    expect(() => db.run('UPDATE events SET type = ?', ['tampered'])).toThrow(
      /append-only/,
    );
    expect(() => db.run('DELETE FROM events')).toThrow(/append-only/);
    expect(db.get<{ type: string }>('SELECT type FROM events')?.type).toBe(
      'mission.created',
    );
  });
});
