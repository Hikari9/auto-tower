import type { OfficeEngine } from '../../../src/adapters/office/engine.js';
import type { OfficePacket } from '../../../src/adapters/office/packet.js';
import type { OfficeReceipt } from '../../../src/adapters/office/receipt.js';
import type { EngineHooks } from '../../../src/runner/engine.js';

/**
 * The mutable world the engine works on. Each mutation is keyed by (attempt, step), and a key
 * that is already applied is counted as a replay instead of a second change. The engine contract
 * requires this idempotency, since a step may run once before a crash and again after reconcile.
 */
export class FakeWorld {
  readonly applied: string[] = [];
  replays = 0;

  applyOnce(key: string): boolean {
    if (this.applied.includes(key)) {
      this.replays += 1;
      return false;
    }
    this.applied.push(key);
    return true;
  }
}

export interface FakeOfficeOptions {
  steps?: number;
  /**
   * Stop after this step's mutation, before its progress is reported. The engine stays stalled
   * until it is aborted, then waits `abortGraceMs` before it returns. With no abort it never
   * returns, which is how a crashed process looks from the outside.
   */
  stallAfterMutation?: { step: number; abortGraceMs?: number };
  /** Return a failed receipt with this class instead of succeeding. */
  failWith?: 'implementation-defect' | 'environment';
  /** A reviewer other than the producer approves the work. Without it the review is missing. */
  reviewer?: string;
}

function waitForAbort(signal: AbortSignal, graceMs: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => setTimeout(resolve, graceMs);
    if (signal.aborted) {
      done();
    } else {
      signal.addEventListener('abort', done, { once: true });
    }
  });
}

/**
 * A test double for the Auto-Office engine. It runs a fixed number of steps, each one a mutation
 * then a progress report, and it honours the resume point it is given.
 */
export class FakeOfficeEngine implements OfficeEngine {
  readonly runs: string[] = [];
  readonly stallReached: Promise<void>;
  /** Runs in progress at once, and the most there have been. Two means two engines shared a repo. */
  active = 0;
  maxActive = 0;
  /** Set when a run returned because it was aborted. */
  aborted = false;
  private markStalled: () => void = () => {};

  constructor(
    private readonly world: FakeWorld,
    private readonly options: FakeOfficeOptions = {},
  ) {
    this.stallReached = new Promise((resolve) => {
      this.markStalled = resolve;
    });
  }

  async run(packet: OfficePacket, hooks: EngineHooks): Promise<OfficeReceipt> {
    this.runs.push(packet.attemptId);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      return await this.runSteps(packet, hooks);
    } finally {
      this.active -= 1;
    }
  }

  private async runSteps(
    packet: OfficePacket,
    hooks: EngineHooks,
  ): Promise<OfficeReceipt> {
    const steps = this.options.steps ?? 3;
    for (let step = 1; step <= steps; step += 1) {
      // Steps the resume point already covers were reported before, so they do not run again.
      if (step <= packet.resume.progressSeq) {
        continue;
      }
      if (hooks.signal.aborted) {
        this.aborted = true;
        throw new Error('stopped');
      }
      this.world.applyOnce(`${packet.attemptId}:${step}`);
      const stall = this.options.stallAfterMutation;
      // Only the first run stalls. A later run is the replacement, and it must be able to finish.
      if (stall?.step === step && this.runs.length === 1) {
        this.markStalled();
        await waitForAbort(hooks.signal, stall.abortGraceMs ?? 0);
        this.aborted = true;
        throw new Error('stopped');
      }
      await hooks.progress(step, `step ${step} of ${steps}`, { step });
    }
    const failed = this.options.failWith !== undefined;
    return {
      contract: 'tower.office.v1',
      kind: 'receipt',
      receiptId: `office.${packet.attemptId.replace(/[^A-Za-z0-9.-]/g, '-')}`,
      correlationId: packet.correlationId,
      runId: 'run-fake',
      outcome: failed ? 'failed' : 'succeeded',
      summary: failed ? 'the fake run failed' : 'the fake run finished',
      executor: { id: 'fake-executor' },
      selfVerification: { result: 'passed', by: 'fake-executor' },
      independentReview:
        this.options.reviewer === undefined
          ? null
          : { reviewer: this.options.reviewer, result: 'approved' },
      integratedVerification: {
        result: 'passed',
        testsRun: steps,
        commitSha: null,
      },
      failure: failed
        ? { class: this.options.failWith ?? null, message: 'fake failure' }
        : null,
      residualRisks: [],
    };
  }
}
