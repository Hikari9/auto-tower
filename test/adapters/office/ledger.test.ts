import { describe, expect, it } from 'vitest';
import {
  createOfficeReviewGuard,
  ingestOfficeReceipt,
  ReceiptConflictError,
} from '../../../src/adapters/office/ledger.js';
import type { OfficeReceipt } from '../../../src/adapters/office/receipt.js';
import { ensureWorkspace } from '../../../src/auth/principals.js';
import {
  CORE_COMPLETION_GUARDS,
  createCompletionGuardRegistry,
} from '../../../src/core/guards.js';
import type { MissionState } from '../../../src/core/types.js';
import type { SqlDatabase } from '../../../src/storage/database.js';
import { openTestDatabase, TEST_WORKSPACE } from '../../helpers/tower.js';

const PRODUCER = 'prn_runner_1';
const NOW = '2026-03-01T00:00:00.000Z';

function db(): SqlDatabase {
  const handle = openTestDatabase();
  ensureWorkspace(handle, TEST_WORKSPACE, TEST_WORKSPACE);
  return handle;
}

function receipt(
  id: string,
  overrides: Partial<OfficeReceipt> = {},
): OfficeReceipt {
  return {
    contract: 'tower.office.v1',
    kind: 'receipt',
    receiptId: id,
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

function ingest(
  handle: SqlDatabase,
  packetId: string,
  attemptId: string,
  body: OfficeReceipt,
  risk: 'low' | 'medium' | 'high' = 'high',
) {
  return ingestOfficeReceipt(handle, {
    workspaceId: TEST_WORKSPACE,
    missionId: 'mis_1',
    packetId,
    attemptId,
    producerIds: [PRODUCER],
    risk,
    // Office echoes the attempt it ran, so the receipt is for the attempt it is ingested under.
    receipt: { ...body, correlationId: attemptId },
    recordedAt: NOW,
  });
}

function mission(
  risk: string,
  packets: Array<{ id: string; required: boolean }>,
): {
  mission: Parameters<
    ReturnType<typeof createOfficeReviewGuard>['check']
  >[0]['mission'];
} {
  // One attempt per packet, named as the tests name them: pkt_1 ran att_1, pkt_2 ran att_2.
  const attempts = packets.map((p, i) => ({
    id: `att_${i + 1}`,
    packetId: p.id,
    number: 1,
  }));
  return {
    mission: {
      id: 'mis_1',
      workspaceId: TEST_WORKSPACE,
      risk,
      packets,
      attempts,
    },
  };
}

describe('ingestOfficeReceipt', () => {
  it('records the facts and reports whether the receipt is ready', () => {
    const handle = db();
    const result = ingest(handle, 'pkt_1', 'att_1', receipt('r1'));
    expect(result.replayed).toBe(false);
    expect(result.ready).toBe(true);
    expect(result.facts.independentReview).toBe('satisfied');
  });

  it('treats the same receipt as a replay and writes nothing new', () => {
    const handle = db();
    ingest(handle, 'pkt_1', 'att_1', receipt('r1'));
    const again = ingest(handle, 'pkt_1', 'att_1', receipt('r1'));
    expect(again.replayed).toBe(true);
    const count = handle.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM office_receipts',
    )?.n;
    expect(count).toBe(1);
  });

  it('refuses a different receipt for an attempt that already has one', () => {
    const handle = db();
    ingest(handle, 'pkt_1', 'att_1', receipt('r1'));
    expect(() => ingest(handle, 'pkt_1', 'att_1', receipt('r2'))).toThrow(
      ReceiptConflictError,
    );
  });

  it('refuses a receipt id already recorded for another attempt', () => {
    const handle = db();
    ingest(handle, 'pkt_1', 'att_1', receipt('r1'));
    expect(() => ingest(handle, 'pkt_2', 'att_2', receipt('r1'))).toThrow(
      ReceiptConflictError,
    );
  });

  it('is append-only at the database', () => {
    const handle = db();
    ingest(handle, 'pkt_1', 'att_1', receipt('r1'));
    expect(() =>
      handle.run("UPDATE office_receipts SET outcome = 'failed'"),
    ).toThrow(/append-only/);
    expect(() => handle.run('DELETE FROM office_receipts')).toThrow(
      /append-only/,
    );
  });
});

describe('createOfficeReviewGuard: high-risk completion', () => {
  function registry(handle: SqlDatabase) {
    const guards = createCompletionGuardRegistry(CORE_COMPLETION_GUARDS);
    guards.register(createOfficeReviewGuard(handle));
    return guards;
  }

  function failuresOf(
    handle: SqlDatabase,
    state: Parameters<ReturnType<typeof createOfficeReviewGuard>['check']>[0],
  ) {
    return registry(handle)
      .evaluate({
        mission: state.mission as unknown as MissionState,
        children: [],
      })
      .filter((f) => f.guard === 'office-high-risk-review');
  }

  it('blocks a high-risk mission whose packets have only green tests', () => {
    const handle = db();
    ingest(
      handle,
      'pkt_1',
      'att_1',
      receipt('r1', { independentReview: null }),
    );
    const failures = failuresOf(
      handle,
      mission('high', [{ id: 'pkt_1', required: true }]),
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]?.reason).toMatch(/pkt_1/);
  });

  it('passes a high-risk mission once every required packet has a ready receipt', () => {
    const handle = db();
    ingest(handle, 'pkt_1', 'att_1', receipt('r1'));
    ingest(handle, 'pkt_2', 'att_2', receipt('r2'));
    expect(
      failuresOf(
        handle,
        mission('high', [
          { id: 'pkt_1', required: true },
          { id: 'pkt_2', required: true },
        ]),
      ),
    ).toEqual([]);
  });

  it('names only the packets still missing a ready receipt', () => {
    const handle = db();
    ingest(handle, 'pkt_1', 'att_1', receipt('r1'));
    const failures = failuresOf(
      handle,
      mission('high', [
        { id: 'pkt_1', required: true },
        { id: 'pkt_2', required: true },
      ]),
    );
    expect(failures[0]?.reason).toMatch(/pkt_2/);
    expect(failures[0]?.reason).not.toMatch(/pkt_1/);
  });

  it('does not let a self-reviewed receipt satisfy a high-risk packet', () => {
    const handle = db();
    ingest(
      handle,
      'pkt_1',
      'att_1',
      receipt('r1', {
        independentReview: { reviewer: PRODUCER, result: 'approved' },
      }),
    );
    expect(
      failuresOf(handle, mission('high', [{ id: 'pkt_1', required: true }])),
    ).toHaveLength(1);
  });

  it('does not gate a medium or low risk mission', () => {
    const handle = db();
    expect(
      failuresOf(handle, mission('medium', [{ id: 'pkt_1', required: true }])),
    ).toEqual([]);
    expect(
      failuresOf(handle, mission('low', [{ id: 'pkt_1', required: true }])),
    ).toEqual([]);
  });

  it('requires at least one ready receipt on a high-risk mission with no required packets', () => {
    const handle = db();
    expect(failuresOf(handle, mission('high', []))).toHaveLength(1);
    ingest(handle, 'pkt_1', 'att_1', receipt('r1'));
    // The packet's attempt must be the mission's, or its receipt does not count.
    const withAttempt = mission('high', []);
    withAttempt.mission.attempts = [
      { id: 'att_1', packetId: 'pkt_1', number: 1 },
    ];
    expect(createOfficeReviewGuard(handle).check(withAttempt)).toEqual({
      ok: true,
    });
  });
});

describe('partial child completion does not complete the parent', () => {
  it('fails the core guard while one required child is still open', () => {
    const handle = db();
    const guards = createCompletionGuardRegistry(CORE_COMPLETION_GUARDS);
    const child = (state: string) =>
      ({
        id: `mis_${state}`,
        state,
        requiredForParent: true,
      }) as unknown as MissionState;
    const parent = {
      id: 'mis_parent',
      workspaceId: TEST_WORKSPACE,
      risk: 'low',
      packets: [],
      definitionOfDone: [],
      outcomeVerification: { at: NOW, by: 'x', evidenceRefs: ['e'] },
    } as unknown as MissionState;
    const partial = guards.evaluate({
      mission: parent,
      children: [child('completed'), child('running')],
    });
    expect(partial.map((f) => f.guard)).toContain(
      'required-children-completed',
    );
    const whole = guards.evaluate({
      mission: parent,
      children: [child('completed'), child('cancelled')],
    });
    expect(whole.map((f) => f.guard)).not.toContain(
      'required-children-completed',
    );
    handle.close();
  });
});

describe('ingestion of a changed body under the same receipt id', () => {
  it('refuses a same-id receipt whose verdict differs, instead of replaying it', () => {
    const handle = db();
    ingestOfficeReceipt(handle, {
      workspaceId: TEST_WORKSPACE,
      missionId: 'mis_1',
      packetId: 'pkt_1',
      attemptId: 'att_1',
      producerIds: [PRODUCER],
      risk: 'high',
      receipt: receipt('r1'),
      recordedAt: NOW,
    });
    expect(() =>
      ingestOfficeReceipt(handle, {
        workspaceId: TEST_WORKSPACE,
        missionId: 'mis_1',
        packetId: 'pkt_1',
        attemptId: 'att_1',
        producerIds: [PRODUCER],
        risk: 'high',
        receipt: receipt('r1', { independentReview: null }),
        recordedAt: NOW,
      }),
    ).toThrow(ReceiptConflictError);
  });
});

describe('ingestion refuses a receipt for another attempt', () => {
  it('refuses a receipt whose correlation id names a different attempt', () => {
    const handle = db();
    expect(() =>
      ingestOfficeReceipt(handle, {
        workspaceId: TEST_WORKSPACE,
        missionId: 'mis_1',
        packetId: 'pkt_1',
        attemptId: 'att_A',
        producerIds: [PRODUCER],
        risk: 'high',
        receipt: receipt('r1', { correlationId: 'att_B' }),
        recordedAt: NOW,
      }),
    ).toThrow(ReceiptConflictError);
    expect(
      handle.get<{ n: number }>('SELECT COUNT(*) AS n FROM office_receipts')?.n,
    ).toBe(0);
  });
});

describe('the gate counts only a packet’s latest attempt', () => {
  it('does not let an earlier attempt’s ready receipt satisfy a later attempt that has none', () => {
    const handle = db();
    // Attempt 1 was ready, then the packet was rejected and requeued. Attempt 2 is the latest.
    ingest(handle, 'pkt_1', 'att_1', receipt('r1'));
    const context = mission('high', [{ id: 'pkt_1', required: true }]);
    const withLatest = {
      mission: {
        ...context.mission,
        attempts: [
          { id: 'att_1', packetId: 'pkt_1', number: 1 },
          { id: 'att_2', packetId: 'pkt_1', number: 2 },
        ],
      },
    };
    const failures = createOfficeReviewGuard(handle).check(withLatest);
    expect(failures.ok).toBe(false);
  });
});
