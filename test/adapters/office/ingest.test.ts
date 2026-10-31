import { describe, expect, it } from 'vitest';
import {
  ingestOfficeEvidence,
  producersOfAttempt,
} from '../../../src/adapters/office/ingest.js';
import type { OfficeReceipt } from '../../../src/adapters/office/receipt.js';
import {
  openTestDatabase,
  seedPrincipal,
  TEST_WORKSPACE,
} from '../../helpers/tower.js';

const NOW = '2026-03-01T00:00:00.000Z';

function receipt(overrides: Partial<OfficeReceipt> = {}): OfficeReceipt {
  return {
    contract: 'tower.office.v1',
    kind: 'receipt',
    receiptId: 'r1',
    correlationId: 'att_1',
    runId: 'run-1',
    outcome: 'succeeded',
    summary: 'done',
    executor: { id: 'exec-1' },
    selfVerification: { result: 'passed', by: 'exec-1' },
    independentReview: { reviewer: 'reviewer-2', result: 'approved' },
    integratedVerification: {
      result: 'passed',
      testsRun: 5,
      commitSha: 'a'.repeat(40),
    },
    failure: null,
    residualRisks: [],
    ...overrides,
  };
}

function setup() {
  const db = openTestDatabase();
  const first = seedPrincipal(db, { kind: 'runner', name: 'first' });
  const second = seedPrincipal(db, { kind: 'runner', name: 'second' });
  return { db, first: first.principalId, second: second.principalId };
}

function input(
  db: ReturnType<typeof openTestDatabase>,
  callerId: string,
  evidence: unknown,
) {
  return {
    workspaceId: TEST_WORKSPACE,
    missionId: 'mis_1',
    packetId: 'pkt_1',
    attemptId: 'att_1',
    risk: 'high' as const,
    callerId,
    evidence,
    recordedAt: NOW,
  };
}

/** The attempt was held by `first`, then reassigned: the lease row stays, and `second` ran it to the end. */
function reassigned(
  db: ReturnType<typeof openTestDatabase>,
  first: string,
  second: string,
) {
  db.exec('PRAGMA foreign_keys = OFF');
  db.run(
    `INSERT INTO runner_leases (workspace_id, id, scope_key, fence, attempt_id, mission_id, packet_id, runner_id, status, granted_at, expires_at, last_proof_at)
     VALUES (?, 'lse_1', 'k', 1, 'att_1', 'mis_1', 'pkt_1', ?, 'fenced', ?, ?, ?)`,
    [TEST_WORKSPACE, first, NOW, NOW, NOW],
  );
  db.run(
    `INSERT INTO runner_leases (workspace_id, id, scope_key, fence, attempt_id, mission_id, packet_id, runner_id, status, granted_at, expires_at, last_proof_at)
     VALUES (?, 'lse_2', 'k', 2, 'att_1', 'mis_1', 'pkt_1', ?, 'completed', ?, ?, ?)`,
    [TEST_WORKSPACE, second, NOW, NOW, NOW],
  );
}

describe('producersOfAttempt', () => {
  it('lists every runner that held the attempt across reassignments, and the sender once', () => {
    const { db, first, second } = setup();
    reassigned(db, first, second);
    const producers = producersOfAttempt(db, TEST_WORKSPACE, 'att_1', second);
    expect(producers.sort()).toEqual([first, second].sort());
  });

  it('includes the sender when the attempt has no lease rows', () => {
    const { db, second } = setup();
    expect(producersOfAttempt(db, TEST_WORKSPACE, 'att_x', second)).toEqual([
      second,
    ]);
  });
});

describe('ingestOfficeEvidence', () => {
  it('does not count the first holder as independent reviewer of work a second holder finished', () => {
    const { db, first, second } = setup();
    reassigned(db, first, second);
    const outcome = ingestOfficeEvidence(
      db,
      input(
        db,
        second,
        receipt({ independentReview: { reviewer: first, result: 'approved' } }),
      ),
    );
    expect(outcome).toEqual({ status: 'ingested', replayed: false });
    const row = db.get<{ independent_review: string }>(
      'SELECT independent_review FROM office_receipts',
    );
    expect(row?.independent_review).toBe('self-reviewed');
  });

  it('accepts a reviewer who held nothing', () => {
    const { db, first, second } = setup();
    reassigned(db, first, second);
    ingestOfficeEvidence(db, input(db, second, receipt()));
    expect(
      db.get<{ independent_review: string }>(
        'SELECT independent_review FROM office_receipts',
      )?.independent_review,
    ).toBe('satisfied');
  });

  it('says nothing was ingested when the Office contract does not parse', () => {
    const { db, second } = setup();
    const outcome = ingestOfficeEvidence(
      db,
      input(db, second, { contract: 'tower.office.v1', kind: 'receipt' }),
    );
    expect(outcome).toMatchObject({
      status: 'not_ingested',
      reason: 'invalid_receipt',
    });
    expect(db.all('SELECT 1 FROM office_receipts')).toHaveLength(0);
  });

  it('names an unsupported major as such, and treats a non-Office body as not Office', () => {
    const { db, second } = setup();
    expect(
      ingestOfficeEvidence(
        db,
        input(db, second, { contract: 'tower.office.v9' }),
      ),
    ).toMatchObject({ status: 'not_ingested', reason: 'unsupported_contract' });
    expect(
      ingestOfficeEvidence(db, input(db, second, { contract: 'other.v1' })),
    ).toEqual({ status: 'not_office' });
    expect(ingestOfficeEvidence(db, input(db, second, null))).toEqual({
      status: 'not_office',
    });
  });

  it('reports a conflicting receipt for the same attempt, and never repeats body content', () => {
    const { db, second } = setup();
    ingestOfficeEvidence(db, input(db, second, receipt()));
    const outcome = ingestOfficeEvidence(
      db,
      input(db, second, receipt({ receiptId: 'r2', summary: 'SECRET-BODY' })),
    );
    expect(outcome).toMatchObject({
      status: 'not_ingested',
      reason: 'conflict',
    });
    expect(JSON.stringify(outcome)).not.toContain('SECRET-BODY');
  });

  it('reports a replay as ingested and replayed', () => {
    const { db, second } = setup();
    ingestOfficeEvidence(db, input(db, second, receipt()));
    expect(ingestOfficeEvidence(db, input(db, second, receipt()))).toEqual({
      status: 'ingested',
      replayed: true,
    });
  });
});
