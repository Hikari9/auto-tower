import { describe, expect, it } from 'vitest';
import {
  createHealthSignals,
  guardStorage,
  healthReport,
  isQuotaFailure,
  STORAGE_QUOTA_EXHAUSTED,
  StorageQuotaError,
  signalsFor,
} from '../../src/ops/index.js';
import type { SqlDatabase } from '../../src/storage/database.js';
import { openSqliteDatabase } from '../../src/storage/sqlite.js';
import {
  openTestDatabase,
  seedPrincipal,
  TEST_WORKSPACE,
} from '../helpers/tower.js';

/** A database that refuses writes with the message SQLite gives for a full disk, while `full` is set. */
function fullable(inner: SqlDatabase) {
  const state = { full: false, writes: 0 };
  const refuse = () => {
    state.writes += 1;
    throw Object.assign(new Error('database or disk is full'), {
      code: 'ERR_SQLITE_ERROR',
      errcode: 13,
    });
  };
  const db: SqlDatabase = {
    exec: (sql) => inner.exec(sql),
    run: (sql, params) => {
      if (state.full && /^\s*(insert|update|delete)/i.test(sql)) {
        refuse();
      }
      return inner.run(sql, params);
    },
    get: (sql, params) => inner.get(sql, params),
    all: (sql, params) => inner.all(sql, params),
    transaction: (fn) => inner.transaction((tx) => fn(tx === inner ? db : tx)),
    close: () => inner.close(),
  };
  return { db, state };
}

describe('isQuotaFailure', () => {
  it('recognizes the error SQLite itself raises when the file cannot grow', () => {
    const db = openSqliteDatabase(':memory:');
    db.exec('CREATE TABLE t (v TEXT)');
    db.exec('PRAGMA max_page_count = 8');
    let caught: unknown;
    try {
      for (let i = 0; i < 200; i += 1) {
        db.run('INSERT INTO t (v) VALUES (?)', ['x'.repeat(4000)]);
      }
    } catch (error) {
      caught = error;
    }
    expect((caught as Error).message).toMatch(/database or disk is full/);
    expect(isQuotaFailure(caught)).toBe(true);
  });

  it.each([
    [{ errcode: 13 }],
    [{ errcode: 13 | (2 << 8) }],
    [{ code: 'SQLITE_FULL' }],
    [{ code: 'D1_STORAGE_LIMIT' }],
  ])('recognizes a driver error carrying %j', (props) => {
    expect(isQuotaFailure(Object.assign(new Error('x'), props))).toBe(true);
  });

  it('recognizes D1 plan-limit text at the start of a plain error', () => {
    expect(isQuotaFailure(new Error('D1_ERROR: Exceeded storage limit'))).toBe(
      true,
    );
    expect(
      isQuotaFailure(
        new Error('D1_ERROR: database or disk is full: SQLITE_FULL'),
      ),
    ).toBe(true);
  });

  it.each([
    'UNIQUE constraint failed: events.seq',
    'no such table: x',
    'busy',
    // Text a caller can put in a domain error must never read as a quota failure.
    'Mission x quota exceeded was not found',
    'database or disk is full',
    'SQLITE_FULL',
  ])('does not take %j for a quota failure when it is only text', (message) => {
    expect(isQuotaFailure(new Error(message))).toBe(false);
  });

  it('does not take a domain error that quotes D1 text, or a code-less errcode, for one', () => {
    class DomainError extends Error {}
    expect(
      isQuotaFailure(new DomainError('D1_ERROR: Exceeded storage limit')),
    ).toBe(false);
    expect(
      isQuotaFailure(Object.assign(new Error('x'), { errcode: 787 })),
    ).toBe(false);
  });

  it('treats its own error and non-errors correctly', () => {
    expect(isQuotaFailure(new StorageQuotaError())).toBe(true);
    expect(isQuotaFailure('database or disk is full')).toBe(false);
  });
});

describe('the quota guard', () => {
  function setup() {
    const base = openTestDatabase();
    const { principalId } = seedPrincipal(base, { kind: 'human' });
    const { db: raw, state } = fullable(base);
    const guarded = guardStorage(raw, {
      now: () => new Date('2026-03-01T00:00:00Z'),
    });
    const write = (id: string) =>
      guarded.run(
        "INSERT INTO ops_halt (workspace_id, halted, reason, changed_by, changed_at) VALUES (?, 0, NULL, ?, '2026-03-01T00:00:00Z')",
        [id, principalId],
      );
    return { base, guarded, state, write, principalId };
  }

  it('passes writes through while the store has room', () => {
    const { guarded, write } = setup();
    write(TEST_WORKSPACE);
    expect(guarded.quota.tripped).toBe(false);
    expect(healthReport(guarded, TEST_WORKSPACE).status).toBe('ok');
  });

  it('trips on the first refused write, then refuses every mutation without trying the store', () => {
    const { guarded, state, write } = setup();
    state.full = true;
    expect(() => write(TEST_WORKSPACE)).toThrow(StorageQuotaError);
    expect(guarded.quota.tripped).toBe(true);
    const attempts = state.writes;

    state.full = false; // Space came back, but an operator has not cleared the guard.
    expect(() => write(TEST_WORKSPACE)).toThrow(StorageQuotaError);
    expect(() => guarded.transaction(() => 1)).toThrow(StorageQuotaError);
    expect(() =>
      guarded.exec(
        "INSERT INTO ops_halt_history (workspace_id, action, actor_id, recorded_at) VALUES ('x','halt','y','z')",
      ),
    ).toThrow(StorageQuotaError);
    expect(state.writes).toBe(attempts);
  });

  it('keeps reads working so state can still be inspected and backed up', () => {
    const { guarded, state, write } = setup();
    write(TEST_WORKSPACE);
    state.full = true;
    expect(() => write('ws_other')).toThrow(StorageQuotaError);
    expect(guarded.get('SELECT workspace_id FROM ops_halt')).toEqual({
      workspace_id: TEST_WORKSPACE,
    });
    expect(guarded.all('SELECT 1 AS one')).toEqual([{ one: 1 }]);
  });

  it('raises a critical, actionable health signal that stays until an operator clears it', () => {
    const { guarded, state, write } = setup();
    state.full = true;
    expect(() => write(TEST_WORKSPACE)).toThrow();
    const report = healthReport(guarded, TEST_WORKSPACE);
    expect(report.status).toBe('critical');
    const signal = report.signals.find(
      (s) => s.code === STORAGE_QUOTA_EXHAUSTED,
    );
    expect(signal).toMatchObject({ severity: 'critical', count: 1 });
    expect(signal?.action).toMatch(/Free storage|raise the plan limit/);
    expect(signal?.message).toMatch(/no new work starts/);

    state.full = false;
    guarded.quota.reset();
    expect(healthReport(guarded, TEST_WORKSPACE).status).toBe('ok');
    write(TEST_WORKSPACE);
    expect(guarded.quota.tripped).toBe(false);
  });

  it('rolls a transaction back as a whole when a write inside it is refused', () => {
    const { base, guarded, state, principalId } = setup();
    expect(() =>
      guarded.transaction((tx) => {
        tx.run(
          "INSERT INTO ops_halt (workspace_id, halted, reason, changed_by, changed_at) VALUES (?, 0, NULL, ?, 'z')",
          [TEST_WORKSPACE, principalId],
        );
        state.full = true;
        tx.run(
          "INSERT INTO ops_halt_history (workspace_id, action, actor_id, recorded_at) VALUES (?, 'halt', ?, 'z')",
          [TEST_WORKSPACE, principalId],
        );
      }),
    ).toThrow(StorageQuotaError);
    expect(base.all('SELECT workspace_id FROM ops_halt')).toEqual([]);
  });

  it('is not tripped by a request whose own text mentions a quota', async () => {
    const { createCore } = await import('../../src/core/index.js');
    const { guardStorage: guard } = await import('../../src/ops/quota.js');
    const db = guard(openTestDatabase());
    seedPrincipal(db, { kind: 'human' });
    const core = createCore({ db });
    const actor = { id: 'prn_x', kind: 'human' as const };
    expect(() =>
      core.missions.cancelMission(
        { workspaceId: TEST_WORKSPACE, actor },
        'x quota exceeded database or disk is full',
        1,
        null,
      ),
    ).toThrow(/not found/);
    expect(db.quota.tripped).toBe(false);
    expect(healthReport(db, TEST_WORKSPACE).status).toBe('ok');
  });

  it('does not trip on an ordinary constraint failure', () => {
    const { guarded, write } = setup();
    write(TEST_WORKSPACE);
    expect(() => write(TEST_WORKSPACE)).toThrow(/UNIQUE|constraint/i);
    expect(guarded.quota.tripped).toBe(false);
  });

  it('shares signals with the handle it wraps', () => {
    const { guarded, state, write, base } = setup();
    state.full = true;
    expect(() => write(TEST_WORKSPACE)).toThrow();
    expect(signalsFor(guarded).has(STORAGE_QUOTA_EXHAUSTED)).toBe(true);
    expect(signalsFor(base).has(STORAGE_QUOTA_EXHAUSTED)).toBe(false);
  });
});

describe('health signals', () => {
  it('count repeats, keep the first time, and clear', () => {
    const signals = createHealthSignals();
    const info = { severity: 'warning' as const, message: 'm', action: 'a' };
    signals.raise('x', info, new Date('2026-01-01T00:00:00Z'));
    signals.raise('x', info, new Date('2026-01-02T00:00:00Z'));
    expect(signals.active()).toEqual([
      {
        code: 'x',
        ...info,
        since: '2026-01-01T00:00:00.000Z',
        lastAt: '2026-01-02T00:00:00.000Z',
        count: 2,
      },
    ]);
    signals.clear('x');
    expect(signals.active()).toEqual([]);
  });

  it('report degraded for a warning and critical for a critical one', () => {
    const db = openTestDatabase();
    signalsFor(db).raise('w', {
      severity: 'warning',
      message: 'm',
      action: 'a',
    });
    expect(healthReport(db, TEST_WORKSPACE).status).toBe('degraded');
    signalsFor(db).raise('c', {
      severity: 'critical',
      message: 'm',
      action: 'a',
    });
    expect(healthReport(db, TEST_WORKSPACE).status).toBe('critical');
  });

  it('report critical when the store cannot be read', () => {
    const db = openTestDatabase();
    db.close();
    expect(healthReport(db, TEST_WORKSPACE)).toMatchObject({
      status: 'critical',
      storageReadable: false,
    });
  });
});
