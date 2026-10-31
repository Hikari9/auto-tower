import type { DispatchContract } from '../../contracts/office-v1.ts';
import type { EngineStatus, OfficeEngine } from './engine.ts';

export interface FakeScript {
  /** Polls before the run finishes. */
  steps?: number;
  outcome?: 'succeed' | 'fail' | 'self_review_only';
  failureClass?: 'environment' | 'implementation_defect' | 'quota';
  /** Ask Tower before "landing" on this step. */
  landAction?: string;
  /** Emit a portable checkpoint after this many polls. */
  checkpointAt?: number;
}

/**
 * Deterministic in-memory office engine for tests, demos and local first-run.
 * It never touches a repository or a model.
 */
export class FakeOfficeEngine implements OfficeEngine {
  readonly id = 'auto-office';
  readonly runs = new Map<string, { contract: DispatchContract; polls: number; script: FakeScript; effect?: { allowed: boolean; reason: string }; cancelled?: string }>();
  private n = 0;
  script: (c: DispatchContract) => FakeScript;

  constructor(script: (c: DispatchContract) => FakeScript = () => ({})) {
    this.script = script;
  }

  async version() {
    return 'fake-1';
  }

  async start(contract: DispatchContract) {
    const localRunId = `fake-${++this.n}-${contract.packet.id}`;
    this.runs.set(localRunId, { contract, polls: 0, script: this.script(contract) });
    return { localRunId };
  }

  async poll(localRunId: string): Promise<EngineStatus> {
    const run = this.runs.get(localRunId);
    if (!run) return { state: 'failed', failure: { class: 'adapter', detail: 'unknown local run (engine restarted without state)', retryable: true } };
    if (run.cancelled) return { state: 'failed', failure: { class: 'cancelled', detail: run.cancelled, retryable: false } };
    run.polls++;
    const s = run.script;
    const steps = s.steps ?? 1;
    const sha = `${run.contract.packet.id.replace(/[^0-9a-f]/g, '').padEnd(7, 'a').slice(0, 7)}`;
    if (run.polls <= steps) {
      const cp = s.checkpointAt !== undefined && run.polls >= s.checkpointAt ? { checkpoint: { portable: true, kind: 'branch' as const, ref: `tower/${run.contract.packet.id}`, sha } } : {};
      return { state: 'running', phase: 'executing', ...cp };
    }
    const review = { status: 'approved' as const, reviewer: { id: 'fake-reviewer', sessionId: `review-${localRunId}`, kind: 'agent' as const }, independence: 'independent' as const, sha };
    if (s.landAction && !run.effect) {
      return { state: 'running', phase: 'awaiting-landing', effect: { key: 'land', action: s.landAction, resource: `repo:${String(run.contract.packet.scope.repo ?? 'none')}`, producerSessionId: localRunId, review } };
    }
    if (s.outcome === 'fail') return { state: 'failed', failure: { class: s.failureClass ?? 'implementation_defect', detail: 'fake failure', retryable: true } };
    const profile = run.contract.evidenceProfile;
    return {
      state: 'succeeded',
      completion: {
        outcome: 'succeeded',
        producer: { engine: 'fake', runId: localRunId, sessionId: localRunId },
        ...(profile.commitSha ? { commitSha: sha } : {}),
        selfVerification: { status: 'pass', summary: 'fake self-verification' },
        ...(s.outcome === 'self_review_only' ? {} : { independentReview: { ...review, summary: 'fake independent review' } }),
        tests: { status: 'pass', summary: '3 passed', count: 3 },
        integratedVerification: { status: profile.integratedVerification ? 'pass' : 'not_run', summary: 'fake integration check' },
        landing: run.effect ? { status: run.effect.allowed ? 'landed' : 'pr_open', sha } : { status: 'not_landed' },
        residualRisks: run.effect && !run.effect.allowed ? [`landing not authorized: ${run.effect.reason}`] : [],
        dodItemsMet: [],
        evidence: [{ kind: 'test-log', summary: 'fake test log' }],
      },
    };
  }

  async effectResult(localRunId: string, _key: string, allowed: boolean, reason: string) {
    const run = this.runs.get(localRunId);
    if (run) run.effect = { allowed, reason };
  }

  async cancel(localRunId: string, reason: string) {
    const run = this.runs.get(localRunId);
    if (run) run.cancelled = reason;
  }

  async pause(localRunId: string) {
    const run = this.runs.get(localRunId);
    if (run) run.cancelled = 'paused';
    return null;
  }
}
