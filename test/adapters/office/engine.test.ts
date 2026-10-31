import { describe, expect, it } from 'vitest';
import {
  officeRunnerEngine,
  receiptEvidence,
} from '../../../src/adapters/office/engine.js';
import type { OfficeReceipt } from '../../../src/adapters/office/receipt.js';
import { ClassifiedFailure } from '../../../src/runner/failure.js';
import { FakeOfficeEngine, FakeWorld } from './fake-engine.js';

const job = {
  leaseId: 'lse_1',
  attemptId: 'att_1',
  missionId: 'mis_1',
  packetId: 'pkt_1',
  scopeKey: 'repo:a#worktree:default',
  fence: 4,
  packet: { title: 'T', instructions: 'I', scope: ['repo:a'] },
  mission: {
    title: 'M',
    intent: 'Intent',
    outcome: 'Outcome',
    constraints: [],
  },
  resume: { progressSeq: 0, checkpoint: null },
};

const signal = new AbortController().signal;
const hooks = {
  signal,
  progress: async () => {},
  checkpoint: async () => {},
};

function receipt(overrides: Partial<OfficeReceipt> = {}): OfficeReceipt {
  return {
    contract: 'tower.office.v1',
    kind: 'receipt',
    receiptId: 'office.r',
    correlationId: 'att_1',
    runId: 'run-1',
    outcome: 'succeeded',
    summary: 'ok',
    executor: { id: 'exec-1' },
    selfVerification: { result: 'passed', by: 'exec-1' },
    independentReview: null,
    integratedVerification: null,
    failure: null,
    residualRisks: [],
    ...overrides,
  };
}

const engineReturning = (body: OfficeReceipt) => ({
  run: async () => body,
});

describe('officeRunnerEngine', () => {
  it('maps a succeeded receipt to a succeeded outcome with no failure class', async () => {
    const result = await officeRunnerEngine(engineReturning(receipt())).run(
      job,
      hooks,
    );
    expect(result.outcome).toBe('succeeded');
    expect(result.failureClass).toBeUndefined();
    expect(result.evidence).toMatchObject({
      receiptId: 'office.r',
      outcome: 'succeeded',
    });
  });

  it('carries the class a failed receipt gave, and defaults the rest', async () => {
    const given = await officeRunnerEngine(
      engineReturning(
        receipt({
          outcome: 'failed',
          failure: { class: 'quota', message: '' },
        }),
      ),
    ).run(job, hooks);
    expect(given.failureClass).toBe('quota');

    const derived = await officeRunnerEngine(
      engineReturning(
        receipt({
          outcome: 'failed',
          selfVerification: { result: 'failed', by: 'exec-1' },
        }),
      ),
    ).run(job, hooks);
    expect(derived.failureClass).toBe('implementation-defect');
  });

  it('refuses a receipt for another attempt', async () => {
    const error = await officeRunnerEngine(
      engineReturning(receipt({ correlationId: 'att_other' })),
    )
      .run(job, hooks)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClassifiedFailure);
  });

  it('builds the packet from the lease, not from anything the engine said', async () => {
    let seen: unknown;
    const engine = {
      run: async (packet: unknown) => {
        seen = packet;
        return receipt();
      },
    };
    await officeRunnerEngine(engine).run(job, hooks);
    expect(seen).toMatchObject({
      correlationId: 'att_1',
      leaseId: 'lse_1',
      fence: 4,
      scopeKey: 'repo:a#worktree:default',
    });
  });
});

describe('receiptEvidence', () => {
  it('caps the free text so evidence stays under Tower’s 16 KB bound', () => {
    const long = 'x'.repeat(5_000);
    const risks = Array.from({ length: 50 }, () => long);
    const evidence = receiptEvidence(
      receipt({
        residualRisks: risks,
        failure: { class: 'quota', message: long },
      }),
    );
    expect(JSON.stringify(evidence).length).toBeLessThan(16 * 1024);
    expect((evidence.residualRisks as string[]).length).toBe(20);
  });
});

describe('FakeOfficeEngine through the glue', () => {
  it('resumes after the confirmed step and does not replay confirmed steps', async () => {
    const world = new FakeWorld();
    const fake = new FakeOfficeEngine(world, { steps: 3 });
    const reported: number[] = [];
    await officeRunnerEngine(fake).run(
      { ...job, resume: { progressSeq: 2, checkpoint: null } },
      {
        ...hooks,
        progress: async (seq) => {
          reported.push(seq);
        },
      },
    );
    expect(reported).toEqual([3]);
    expect(world.applied).toEqual(['att_1:3']);
  });
});

describe('failure classes and caps through the glue', () => {
  it('derives review-failure when a failed run has no integrated failure and a missing review', async () => {
    const result = await officeRunnerEngine(
      engineReturning(
        receipt({
          outcome: 'failed',
          selfVerification: { result: 'passed', by: 'exec-1' },
          integratedVerification: null,
          independentReview: null,
          failure: null,
        }),
      ),
    ).run(job, hooks);
    expect(result.failureClass).toBe('review-failure');
  });

  it('a rejected review on a failed run is a review-failure', async () => {
    const result = await officeRunnerEngine(
      engineReturning(
        receipt({
          outcome: 'failed',
          independentReview: { reviewer: 'reviewer-2', result: 'rejected' },
          failure: null,
        }),
      ),
    ).run(job, hooks);
    expect(result.failureClass).toBe('review-failure');
  });

  it('caps a long failure message in the stored evidence', () => {
    const evidence = receiptEvidence(
      receipt({
        outcome: 'failed',
        failure: { class: 'quota', message: 'm'.repeat(5_000) },
      }),
    );
    const failure = evidence.failure as { class: string; message: string };
    expect(failure.message.length).toBeLessThanOrEqual(1_000);
    expect(failure.class).toBe('quota');
  });

  it('classifies an attempt mismatch as an adapter failure specifically', async () => {
    const error = (await officeRunnerEngine(
      engineReturning(receipt({ correlationId: 'att_other' })),
    )
      .run(job, hooks)
      .catch((e: unknown) => e)) as ClassifiedFailure;
    expect(error.failureClass).toBe('adapter');
  });
});
