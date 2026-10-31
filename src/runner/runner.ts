import { createHash } from 'node:crypto';
import type {
  EngineHooks,
  EngineJob,
  EngineResult,
  RunnerEngine,
} from './engine.js';
import {
  ClassifiedFailure,
  classifyError,
  type FailureClass,
} from './failure.js';
import {
  type Assignment,
  type Binding,
  type Evidence,
  parseClaim,
  parseProgress,
  parseReceiptResponse,
  parseReconcile,
  parseRegister,
  type ReceiptBody,
  type Resume,
} from './protocol.js';
import type { LocalLease, RunnerState, StateStore } from './state.js';
import {
  refusalOf,
  TowerRefusal,
  type Transport,
  TransportError,
  type TransportResponse,
} from './transport.js';

/** Codes that mean the lease is gone for this runner. The work is no longer its to report. */
const LEASE_LOST = new Set([
  'lease_fenced',
  'lease_closed',
  'attempt_cancelled',
  'lease_not_found',
]);

/** Codes that stop the runner altogether. Retrying them changes nothing. */
const FATAL = new Set([
  'runner_quarantined',
  'runner_required',
  'version_mismatch',
  'version_unsupported',
  'credential_not_bound',
]);

const MAX_SUMMARY = 4_000;
/** The longest delay a timer accepts. A longer Tower retry hint is clamped to it. */
const MAX_TIMER_MS = 2_147_483_647;

/** An engine step was refused because its lease is gone. Not a failure of the engine itself. */
class LeaseStopped extends Error {
  override readonly name = 'LeaseStopped';
}

export interface RunnerOptions {
  transport: Transport;
  engine: RunnerEngine;
  store: StateStore;
  /** The version and digest this runner runs as. Tower checks them on every call. */
  binding: Binding;
  capabilities?: string[];
  /** Used when Tower does not say how long to wait. */
  pollIntervalMs?: number;
  log?: (line: string) => void;
}

export interface PollReport {
  started: string[];
  reconciled: string[];
  receiptsSent: string[];
  /** Leases this runner let go of, and why: cancelled, or fenced by a newer holder. */
  dropped: Array<{ leaseId: string; reason: string }>;
  withheld: Array<{ attemptId: string; reason: string }>;
  retryAfterMs: number;
}

interface Job {
  controller: AbortController;
  done: Promise<void>;
}

function blankReport(): PollReport {
  return {
    started: [],
    reconciled: [],
    receiptsSent: [],
    dropped: [],
    withheld: [],
    retryAfterMs: 0,
  };
}

/**
 * A runner's receipt id. It is derived from the lease, so a resend after a lost response has the
 * same id. The hash keeps it inside Tower's id character set.
 */
function receiptIdFor(leaseId: string): string {
  return `rcpt-${createHash('sha256').update(leaseId).digest('hex').slice(0, 40)}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}

function isFatal(error: unknown): boolean {
  return error instanceof TowerRefusal && FATAL.has(error.code);
}

/** A refusal Tower may give again later: overload, or a server fault. The work is not lost. */
function isTransient(error: unknown): boolean {
  return (
    error instanceof TowerRefusal &&
    (error.status === 429 || error.status >= 500)
  );
}

/**
 * Polls Tower and runs the leases it grants. Tower decides which work is granted, and this class
 * keeps the runner's side of the protocol: the fence it holds, the steps Tower has confirmed, and
 * the receipt it still owes. Every change that Tower must not forget is written before the call
 * that depends on it, so a crash between the two is recovered by reconciling on the next start.
 */
export class TowerRunner {
  private state: RunnerState | undefined;
  private readonly jobs = new Map<string, Job>();
  private readonly capabilities: string[];
  private readonly pollIntervalMs: number;
  private readonly log: (line: string) => void;
  /** Set by stop(). A stopping runner starts no new job. */
  private stopping = false;
  /** A fatal refusal that a running job hit. run() throws it. */
  private fatal: unknown;
  /** Leases whose receipt or reconcile Tower refused for good. They are not retried in this process. */
  private readonly parked = new Set<string>();

  constructor(private readonly options: RunnerOptions) {
    this.capabilities = options.capabilities ?? [];
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.log = options.log ?? (() => {});
  }

  /** Redeems an enrollment token once. The credential Tower returns is stored in the state. */
  async register(enrollmentToken: string): Promise<void> {
    if (this.options.store.load() !== undefined) {
      throw new Error('This state already holds a registered runner');
    }
    const res = await this.options.transport({
      method: 'POST',
      path: '/runners/register',
      body: { ...this.options.binding, capabilities: this.capabilities },
      token: enrollmentToken,
    });
    if (res.status !== 201) {
      throw refusalOf(res);
    }
    const registered = parseRegister(res.body);
    this.state = {
      runnerId: registered.runnerId,
      token: registered.token,
      leases: {},
    };
    this.persist();
  }

  /**
   * Loads the stored state. Leases that were running when the last process stopped have no
   * engine now, so they wait for reconcile. No work starts here.
   */
  start(): void {
    const loaded = this.options.store.load();
    if (loaded === undefined) {
      throw new Error('This state holds no registered runner; register first');
    }
    for (const lease of Object.values(loaded.leases)) {
      if (lease.phase === 'running') {
        lease.phase = 'reconcile';
      }
    }
    this.state = loaded;
    this.persist();
  }

  get runnerId(): string | undefined {
    return this.state?.runnerId;
  }

  /** One poll: settle what is owed, reconcile what needs it, claim, and act on the answer. */
  async pollOnce(): Promise<PollReport> {
    this.requireState();
    const report = blankReport();

    for (const lease of this.leases()) {
      if (
        lease.receipt !== null &&
        !this.jobs.has(lease.leaseId) &&
        !this.parked.has(lease.leaseId)
      ) {
        await this.guarded(lease.leaseId, () =>
          this.sendReceipt(lease, report),
        );
      }
    }
    for (const lease of this.leases()) {
      if (
        lease.phase === 'reconcile' &&
        !this.jobs.has(lease.leaseId) &&
        !this.parked.has(lease.leaseId)
      ) {
        await this.guarded(lease.leaseId, () =>
          this.reconcileLease(lease, report),
        );
      }
    }

    const active: Evidence[] = this.leases()
      .filter(
        (lease) =>
          lease.phase === 'running' &&
          this.jobs.has(lease.leaseId) &&
          !this.parked.has(lease.leaseId),
      )
      .map((lease) => ({
        leaseId: lease.leaseId,
        attemptId: lease.attemptId,
        fence: lease.fence,
        progressSeq: lease.progressSeq,
      }));
    const claim = parseClaim(
      this.ok(
        await this.call('POST', '/runners/claims', {
          ...this.options.binding,
          capabilities: this.capabilities,
          active,
        }),
      ),
    );
    report.retryAfterMs = claim.retryAfterMs;
    report.withheld = claim.withheld;

    for (const view of claim.leases) {
      if (view.directives.cancel) {
        await this.stopJob(view.leaseId, 'drop', report, 'cancelled by Tower');
      }
    }
    // A cancelled lease is closed by the sweep, so Tower answers its evidence here instead.
    for (const miss of claim.unmatched) {
      if (miss.cancel) {
        await this.stopJob(miss.leaseId, 'drop', report, 'cancelled by Tower');
      }
    }
    for (const view of claim.reconcile) {
      const lease = this.state?.leases[view.leaseId];
      if (lease !== undefined && lease.phase !== 'finishing') {
        // The old job must end before a new one can run in the same repository.
        await this.stopJob(view.leaseId, 'recover', report);
        await this.guarded(view.leaseId, () =>
          this.reconcileLease(lease, report),
        );
      }
    }
    // A stopping runner starts nothing new. Anything it was granted waits for the next start.
    if (this.stopping) {
      this.persist();
      return report;
    }
    for (const assignment of claim.assignments) {
      await this.accept(assignment, report);
    }
    this.persist();
    return report;
  }

  /** Polls until `signal` aborts. Fatal refusals stop the loop and are thrown to the caller. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let wait = this.pollIntervalMs;
      try {
        const report = await this.pollOnce();
        wait =
          report.retryAfterMs > 0 ? report.retryAfterMs : this.pollIntervalMs;
      } catch (error) {
        if (isFatal(error)) {
          // The runner is out of service, so its running jobs stop before the error leaves.
          this.stop();
          throw error;
        }
        this.log(`poll failed: ${describeError(error)}`);
      }
      // A fatal refusal from a running job reaches the caller here, not only from a poll.
      if (this.fatal !== undefined) {
        throw this.fatal;
      }
      await sleep(Math.min(wait, MAX_TIMER_MS), signal);
    }
  }

  /** Resolves when no job is running. Tests use it to wait for work to settle. */
  async drain(): Promise<void> {
    while (this.jobs.size > 0) {
      await Promise.allSettled([...this.jobs.values()].map((job) => job.done));
    }
  }

  /**
   * Stops every running job without telling Tower. Use it when the process is going down: the
   * leases stay as they are, and the next start reconciles them.
   */
  stop(): void {
    this.stopping = true;
    for (const job of this.jobs.values()) {
      job.controller.abort();
    }
  }

  /** Runs `work` for one lease. A refusal Tower will not change parks the lease. Transport and fatal errors propagate. */
  private async guarded(
    leaseId: string,
    work: () => Promise<void>,
  ): Promise<void> {
    try {
      await work();
    } catch (error) {
      if (
        isFatal(error) ||
        error instanceof TransportError ||
        isTransient(error)
      ) {
        throw error;
      }
      this.parked.add(leaseId);
      this.log(`lease ${leaseId} parked: ${describeError(error)}`);
    }
  }

  private async accept(
    assignment: Assignment,
    report: PollReport,
  ): Promise<void> {
    const existing = this.state?.leases[assignment.leaseId];
    if (existing !== undefined) {
      // Receipt and reconcile settle their own leases. A job already running on this fence stays.
      if (existing.phase === 'finishing' || existing.phase === 'reconcile') {
        return;
      }
      if (
        this.jobs.has(assignment.leaseId) &&
        existing.fence === assignment.fence
      ) {
        return;
      }
      await this.stopJob(
        assignment.leaseId,
        'drop',
        report,
        'superseded by a new fence',
      );
    }
    const resume: Resume = assignment.resume ?? {
      progressSeq: 0,
      checkpoint: null,
    };
    const lease: LocalLease = {
      leaseId: assignment.leaseId,
      attemptId: assignment.attemptId,
      missionId: assignment.missionId,
      packetId: assignment.packetId,
      scopeKey: assignment.scopeKey,
      fence: assignment.fence,
      progressSeq: resume.progressSeq,
      packet: assignment.packet,
      mission: assignment.mission,
      phase: 'running',
      receipt: null,
    };
    this.requireState().leases[lease.leaseId] = lease;
    this.persist();
    report.started.push(lease.leaseId);
    this.launch(lease, resume);
  }

  private async reconcileLease(
    lease: LocalLease,
    report: PollReport,
  ): Promise<void> {
    const res = await this.call(
      'POST',
      `/runners/leases/${lease.leaseId}/reconcile`,
      {
        ...this.options.binding,
        fence: lease.fence,
        progressSeq: lease.progressSeq,
      },
    );
    if (!isOk(res)) {
      const refusal = refusalOf(res);
      if (LEASE_LOST.has(refusal.code)) {
        this.drop(lease.leaseId, report, refusal.code);
        return;
      }
      throw refusal;
    }
    const answer = parseReconcile(res.body);
    // Tower's record wins over ours, whatever this runner had counted.
    lease.progressSeq = answer.resume.progressSeq;
    if (answer.assignment === null) {
      lease.phase = 'reconcile';
      report.withheld.push({
        attemptId: lease.attemptId,
        reason: answer.withheld ?? 'waiting for reconcile',
      });
      this.persist();
      return;
    }
    lease.fence = answer.lease.fence;
    if (lease.receipt !== null) {
      // The work already ended here. Only the receipt is still owed.
      lease.phase = 'finishing';
      this.persist();
      await this.sendReceipt(lease, report);
      return;
    }
    lease.phase = 'running';
    this.persist();
    report.reconciled.push(lease.leaseId);
    this.launch(lease, answer.resume);
  }

  private launch(lease: LocalLease, resume: Resume): void {
    if (this.stopping) {
      return;
    }
    const controller = new AbortController();
    const job: Job = {
      controller,
      done: this.execute(lease, resume, controller.signal)
        .catch((error: unknown) => {
          if (isFatal(error)) {
            this.fatal = error;
            this.stop();
          }
          // The lease keeps its receipt, so the next poll sends it again.
          this.log(
            `lease ${lease.leaseId} settle failed: ${describeError(error)}`,
          );
        })
        .finally(() => {
          if (this.jobs.get(lease.leaseId) === job) {
            this.jobs.delete(lease.leaseId);
          }
        }),
    };
    this.jobs.set(lease.leaseId, job);
  }

  private async execute(
    lease: LocalLease,
    resume: Resume,
    signal: AbortSignal,
  ): Promise<void> {
    const hooks: EngineHooks = {
      signal,
      progress: (seq, message, data = {}) =>
        this.reportStep(lease, signal, seq, message, data),
      checkpoint: (ref, commit) =>
        this.recordCheckpoint(lease, signal, ref, commit),
    };
    const job: EngineJob = {
      leaseId: lease.leaseId,
      attemptId: lease.attemptId,
      missionId: lease.missionId,
      packetId: lease.packetId,
      scopeKey: lease.scopeKey,
      fence: lease.fence,
      packet: lease.packet,
      mission: lease.mission,
      resume,
    };
    let result: EngineResult;
    try {
      result = await this.options.engine.run(job, hooks);
    } catch (error) {
      if (signal.aborted) {
        return;
      }
      result = {
        outcome: 'failed',
        summary: `engine ${classifyError(error)} failure: ${describeError(error)}`,
        evidence: {},
        failureClass: classifyError(error),
      };
    }
    if (signal.aborted) {
      return;
    }
    const failureClass: FailureClass | undefined =
      result.outcome === 'failed'
        ? (result.failureClass ?? 'adapter')
        : undefined;
    lease.receipt = {
      receiptId: receiptIdFor(lease.leaseId),
      fence: lease.fence,
      outcome: result.outcome,
      summary: result.summary.slice(0, MAX_SUMMARY),
      evidence:
        failureClass === undefined
          ? result.evidence
          : { ...result.evidence, failureClass },
    };
    lease.phase = 'finishing';
    this.persist();
    await this.sendReceipt(lease, null);
  }

  private async reportStep(
    lease: LocalLease,
    signal: AbortSignal,
    seq: number,
    message: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (signal.aborted) {
      throw new LeaseStopped('stopped');
    }
    // A step Tower already holds is a replay. Nothing is sent for it.
    if (seq <= lease.progressSeq) {
      return;
    }
    if (seq !== lease.progressSeq + 1) {
      throw new ClassifiedFailure(
        'runner',
        `step ${seq} follows ${lease.progressSeq}, which is not the next step`,
      );
    }
    const res = await this.call(
      'POST',
      `/runners/leases/${lease.leaseId}/progress`,
      { fence: lease.fence, seq, message, data },
    );
    if (signal.aborted) {
      throw new LeaseStopped('stopped');
    }
    if (!isOk(res)) {
      this.refusedWrite(lease, signal, res);
    }
    const answer = parseProgress(res.body);
    lease.progressSeq = seq;
    this.persist();
    if (answer.directives.cancel) {
      void this.stopJob(lease.leaseId, 'drop', null, 'cancelled by Tower');
      throw new LeaseStopped('cancelled');
    }
  }

  private async recordCheckpoint(
    lease: LocalLease,
    signal: AbortSignal,
    ref: string,
    commit: string | null,
  ): Promise<void> {
    if (signal.aborted) {
      throw new LeaseStopped('stopped');
    }
    const res = await this.call(
      'POST',
      `/runners/leases/${lease.leaseId}/checkpoints`,
      { fence: lease.fence, ref, commit },
    );
    if (signal.aborted) {
      throw new LeaseStopped('stopped');
    }
    if (!isOk(res)) {
      this.refusedWrite(lease, signal, res);
    }
  }

  /**
   * Sends the owed receipt. A lost lease drops the work; an expired one returns it to
   * reconcile with the receipt still owed.
   */
  private async sendReceipt(
    lease: LocalLease,
    report: PollReport | null,
  ): Promise<void> {
    const receipt = lease.receipt;
    if (receipt === null) {
      return;
    }
    const body: ReceiptBody = { ...receipt, fence: lease.fence };
    const res = await this.call(
      'POST',
      `/runners/leases/${lease.leaseId}/receipts`,
      body,
    );
    if (isOk(res)) {
      parseReceiptResponse(res.body);
      delete this.requireState().leases[lease.leaseId];
      this.persist();
      report?.receiptsSent.push(lease.leaseId);
      return;
    }
    const refusal = refusalOf(res);
    if (LEASE_LOST.has(refusal.code)) {
      this.drop(lease.leaseId, report, refusal.code);
      return;
    }
    if (refusal.code === 'lease_expired') {
      lease.phase = 'reconcile';
      this.persist();
      return;
    }
    throw refusal;
  }

  /**
   * A refused write from a job. Only the job that still holds the lease may change its state. A
   * stale job, one that a newer fence has already replaced, must not drop or recover the new one.
   */
  private refusedWrite(
    lease: LocalLease,
    signal: AbortSignal,
    res: TransportResponse,
  ): never {
    const refusal = refusalOf(res);
    const current = this.jobs.get(lease.leaseId)?.controller.signal === signal;
    if (!current || signal.aborted) {
      throw new LeaseStopped(refusal.code);
    }
    if (LEASE_LOST.has(refusal.code)) {
      void this.stopJob(lease.leaseId, 'drop', null, refusal.code);
    } else if (refusal.code === 'lease_expired') {
      void this.stopJob(lease.leaseId, 'recover', null);
    } else {
      throw refusal;
    }
    throw new LeaseStopped(refusal.code);
  }

  /**
   * Aborts a job. `drop` forgets the lease, `recover` keeps it for reconcile. Resolves once the
   * job has ended, so a caller can start the next run in the same repository only after this one.
   */
  private stopJob(
    leaseId: string,
    mode: 'drop' | 'recover',
    report: PollReport | null,
    reason = 'stopped',
  ): Promise<void> {
    const job = this.jobs.get(leaseId);
    if (job !== undefined) {
      job.controller.abort();
      this.jobs.delete(leaseId);
    }
    if (mode === 'drop') {
      this.drop(leaseId, report, reason);
    } else {
      const lease = this.state?.leases[leaseId];
      if (lease !== undefined) {
        lease.phase = 'reconcile';
        this.persist();
      }
    }
    return job?.done ?? Promise.resolve();
  }

  private drop(
    leaseId: string,
    report: PollReport | null,
    reason: string,
  ): void {
    const state = this.requireState();
    if (state.leases[leaseId] !== undefined) {
      delete state.leases[leaseId];
      this.persist();
    }
    report?.dropped.push({ leaseId, reason });
    this.log(`lease ${leaseId} dropped: ${reason}`);
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    token?: string,
  ): Promise<TransportResponse> {
    const credential = token ?? this.requireState().token;
    return this.options.transport({
      method,
      path,
      ...(body === undefined ? {} : { body }),
      token: credential,
    });
  }

  private ok(res: TransportResponse): unknown {
    if (!isOk(res)) {
      throw refusalOf(res);
    }
    return res.body;
  }

  private leases(): LocalLease[] {
    return Object.values(this.state?.leases ?? {});
  }

  private requireState(): RunnerState {
    if (this.state === undefined) {
      throw new Error(
        'The runner is not started; call start() or register() first',
      );
    }
    return this.state;
  }

  private persist(): void {
    if (this.state !== undefined) {
      this.options.store.save(this.state);
    }
  }
}

function isOk(res: TransportResponse): boolean {
  return res.status >= 200 && res.status < 300;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
  });
}
