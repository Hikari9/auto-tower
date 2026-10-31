import { afterEach, describe, expect, it, vi } from 'vitest';
import { isUniqueViolation } from '../../src/fleet/errors.js';
import { openSqliteDatabase } from '../../src/storage/sqlite.js';
import { createFleetHarness, type FleetHarness } from '../fleet/helpers.js';

afterEach(() => {
  vi.restoreAllMocks();
});

async function leased(h: FleetHarness) {
  const runner = await h.runner();
  await runner.claim();
  h.mission([{ scope: ['repo:app'] }]);
  h.tick();
  const lease = (await runner.claim()).body.assignments[0];
  return { runner, lease };
}

const officeBody = (overrides: Record<string, unknown> = {}) => ({
  contract: 'tower.office.v1',
  kind: 'receipt',
  receiptId: 'office-1',
  correlationId: 'wrong-attempt',
  runId: 'run-1',
  outcome: 'succeeded',
  summary: 's',
  executor: { id: 'exec' },
  selfVerification: { result: 'passed', by: 'exec' },
  integratedVerification: {
    result: 'passed',
    testsRun: 1,
    commitSha: 'a'.repeat(40),
  },
  failure: null,
  residualRisks: [],
  ...overrides,
});

describe('a receipt whose Office contract does not parse', () => {
  it('stores the runner receipt and says nothing was ingested, not a silent 201', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = createFleetHarness();
    const { runner, lease } = await leased(h);
    const res = await runner.receipt(lease.leaseId, {
      receiptId: 'r1',
      fence: lease.fence,
      outcome: 'succeeded',
      evidence: {
        contract: 'tower.office.v1',
        kind: 'receipt',
        secret: 'SECRET-BODY',
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.replayed).toBe(false);
    expect(res.body.office).toMatchObject({
      ingested: false,
      reason: 'invalid_receipt',
    });
    expect(typeof res.body.office.message).toBe('string');
    expect(h.db.all('SELECT 1 FROM office_receipts')).toEqual([]);
    expect(h.db.all('SELECT 1 FROM runner_receipts')).toHaveLength(1);
    // The log names the reason and never the body.
    expect(JSON.stringify(quiet.mock.calls)).not.toContain('SECRET-BODY');
  });

  it('names an unsupported major, and a receipt for another attempt as a conflict', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = createFleetHarness();
    const { runner, lease } = await leased(h);
    const res = await runner.receipt(lease.leaseId, {
      receiptId: 'r1',
      fence: lease.fence,
      outcome: 'succeeded',
      evidence: { contract: 'tower.office.v9' },
    });
    expect(res.body.office).toMatchObject({
      ingested: false,
      reason: 'unsupported_contract',
    });

    const h2 = createFleetHarness();
    const second = await leased(h2);
    const mismatch = await second.runner.receipt(second.lease.leaseId, {
      receiptId: 'r2',
      fence: second.lease.fence,
      outcome: 'succeeded',
      evidence: officeBody(),
    });
    expect(mismatch.body.office).toMatchObject({
      ingested: false,
      reason: 'conflict',
    });
  });

  it('reports a valid Office receipt as ingested, and a replay as the same', async () => {
    const h = createFleetHarness();
    const { runner, lease } = await leased(h);
    const body = {
      receiptId: 'r1',
      fence: lease.fence,
      outcome: 'succeeded',
      evidence: officeBody({ correlationId: lease.attemptId }),
    };
    const first = await runner.receipt(lease.leaseId, body);
    expect(first.status).toBe(201);
    expect(first.body.office).toEqual({ ingested: true });
    const again = await runner.receipt(lease.leaseId, body);
    expect(again.status).toBe(200);
    expect(again.body.office).toEqual({ ingested: true });
    expect(h.db.all('SELECT 1 FROM office_receipts')).toHaveLength(1);
  });

  it('adds nothing for a receipt that does not claim the Office contract', async () => {
    const h = createFleetHarness();
    const { runner, lease } = await leased(h);
    const res = await runner.receipt(lease.leaseId, {
      receiptId: 'r1',
      fence: lease.fence,
      outcome: 'succeeded',
      evidence: { tests: 12 },
    });
    expect(res.status).toBe(201);
    expect(res.body).not.toHaveProperty('office');
  });
});

describe('a claim that loses a race on a unique index', () => {
  it('answers 409 claim_conflict, not 500, and leaves no lease behind', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = createFleetHarness();
    const runner = await h.runner();
    await runner.claim();
    h.mission([{ scope: ['repo:app'] }]);
    h.tick();
    // What another connection winning the insert looks like to this one.
    h.db.exec(`CREATE TRIGGER t9_race BEFORE INSERT ON runner_leases
      BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: runner_leases.workspace_id, runner_leases.scope_key'); END;`);
    const res = await runner.claim();
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('claim_conflict');
    expect(res.body.error.message).toMatch(/Poll again/);
    h.db.exec('DROP TRIGGER t9_race');
    expect(h.db.all('SELECT id FROM runner_leases')).toEqual([]);
    // Polling again succeeds: nothing was left half done.
    expect((await runner.claim()).body.assignments).toHaveLength(1);
  });

  it('does not turn another database error into a conflict', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const h = createFleetHarness();
    const runner = await h.runner();
    await runner.claim();
    h.mission([{ scope: ['repo:app'] }]);
    h.tick();
    h.db.exec(`CREATE TRIGGER t9_other BEFORE INSERT ON runner_leases
      BEGIN SELECT RAISE(ABORT, 'something else broke'); END;`);
    expect((await runner.claim()).status).toBe(500);
  });

  it('recognises the errors SQLite raises for a duplicate key, and nothing else', () => {
    const db = openSqliteDatabase(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, u TEXT UNIQUE)');
    db.run('INSERT INTO t (id, u) VALUES (1, ?)', ['a']);
    for (const sql of [
      'INSERT INTO t (id, u) VALUES (1, ?)',
      'INSERT INTO t (id, u) VALUES (2, ?)',
    ]) {
      let caught: unknown;
      try {
        db.run(sql, ['a']);
      } catch (error) {
        caught = error;
      }
      expect(isUniqueViolation(caught), sql).toBe(true);
    }
    expect(isUniqueViolation(new Error('database or disk is full'))).toBe(
      false,
    );
    expect(isUniqueViolation('UNIQUE constraint failed')).toBe(false);
  });
});
