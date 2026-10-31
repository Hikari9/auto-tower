import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { isUniqueViolation } from '../../src/fleet/errors.js';
import { createIssueService, signGitHubBody } from '../../src/issues/index.js';
import { guardStorage } from '../../src/ops/index.js';
import { openSqliteDatabase } from '../../src/storage/sqlite.js';
import { createFleetHarness, type FleetHarness } from '../fleet/helpers.js';
import { openTestDatabase, seedPrincipal } from '../helpers/tower.js';
import {
  createIssueApi,
  ISSUE_URL,
  missionWithLinks,
  WEBHOOK_SECRET,
} from '../issues/helpers.js';

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

describe('a full store over HTTP', () => {
  it('answers 503 with the code and the instruction, not a bare 500, and still answers reads', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const raw = openTestDatabase();
    const full = { on: false };
    const wrapped = {
      ...raw,
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
      transaction: <T>(fn: (tx: typeof raw) => T): T =>
        raw.transaction((tx) => fn(tx === raw ? (wrapped as typeof raw) : tx)),
    } as typeof raw;
    const db = guardStorage(wrapped);
    const owner = seedPrincipal(raw, { kind: 'human' });
    const app = createApp({ db });
    const call = (method: string, path: string, body?: unknown) =>
      app.request(path, {
        method,
        headers: {
          authorization: `Bearer ${owner.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const mission = { title: 't', intent: 'i', outcome: 'o' };
    expect((await call('POST', '/missions', mission)).status).toBe(201);

    full.on = true;
    const refused = await call('POST', '/missions', {
      ...mission,
      title: 'two',
    });
    expect(refused.status).toBe(503);
    const body = (await refused.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe('storage_quota_exhausted');
    expect(body.error.message).toMatch(
      /Writes are refused until an operator clears it/,
    );
    full.on = false;
    // Reads still answer while the guard holds.
    expect((await call('GET', '/missions')).status).toBe(200);
    expect(
      (await call('POST', '/missions', { ...mission, title: 'three' })).status,
    ).toBe(503);
    quiet.mockRestore();
  });

  it('answers a signed webhook with 503 while the guard is tripped, and processes the retry once cleared', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const api = createIssueApi();
    const h = api.h;
    h.github.add(ISSUE_URL);
    h.issues.setSyncConfig(h.ctx(h.owner), {
      provider: 'github',
      repo: 'acme/web',
      mode: 'observe',
    });
    const driver = missionWithLinks(h);
    await h.issues.verifyMission(h.ctx(h.owner), driver.id);
    // A guarded handle over the same store, trippable, behind a second app.
    const full = { on: true };
    const raw = h.db;
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
    const guarded = guardStorage(wrapped);
    const issues = createIssueService({
      db: guarded,
      core: h.core,
      policy: h.authority.policy,
      providers: { github: h.github },
      clock: h.clock.now,
    });
    const app = createApp({
      db: guarded,
      now: h.clock.now,
      core: h.core,
      authority: h.authority,
      issues,
      issueProviders: { github: h.github },
      webhooks: {
        resolve: () => ({ secret: WEBHOOK_SECRET, actorId: h.provider.id }),
      },
    });
    const body = new TextEncoder().encode(
      JSON.stringify({
        action: 'reopened',
        repository: { full_name: 'acme/web' },
        issue: {
          number: 1,
          node_id: 'node_acme/web_1',
          state: 'open',
          title: 'Fix',
        },
      }),
    );
    const post = () =>
      app.request('/webhooks/github/ws_test', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-github-event': 'issues',
          'x-github-delivery': 'D-quota',
          'x-hub-signature-256': signGitHubBody(WEBHOOK_SECRET, body),
        },
        body,
      });
    const refused = await post();
    expect(refused.status).toBe(503);
    expect(
      ((await refused.json()) as { error: { code: string } }).error.code,
    ).toBe('storage_quota_exhausted');
    expect(h.db.all('SELECT 1 FROM webhook_deliveries')).toEqual([]);
    full.on = false;
    guarded.quota.reset();
    const retry = await post();
    expect(retry.status).toBe(200);
    expect(h.db.all('SELECT 1 FROM webhook_deliveries')).toHaveLength(1);
    quiet.mockRestore();
  });
});
