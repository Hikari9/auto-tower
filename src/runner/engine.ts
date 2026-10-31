import type { FailureClass } from './failure.js';
import type { Assignment, Resume } from './protocol.js';

/** One lease the runner is executing, as the engine sees it. */
export interface EngineJob {
  leaseId: string;
  attemptId: string;
  missionId: string;
  packetId: string;
  scopeKey: string;
  fence: number;
  packet: Assignment['packet'];
  mission: Assignment['mission'];
  /**
   * Where Tower's record ends. Steps up to `progressSeq` were reported and must not be reported
   * again. A step after it may have run before the crash, so the engine's mutations must be
   * idempotent under (attemptId, step).
   */
  resume: Resume;
}

export interface EngineHooks {
  /**
   * Reports step `seq`. A step at or below the last one Tower confirmed is a no-op, so a replay
   * is safe. A gap is rejected, so steps go out in order.
   */
  progress(
    seq: number,
    message: string,
    data?: Record<string, unknown>,
  ): Promise<void>;
  checkpoint(ref: string, commit: string | null): Promise<void>;
  /** Aborted when Tower cancels the attempt, or fences or expires this lease. Check it between steps. */
  signal: AbortSignal;
}

export interface EngineResult {
  outcome: 'succeeded' | 'failed';
  summary: string;
  /** Kept small: Tower stores it with the receipt and refuses bodies over 16 KB. */
  evidence: Record<string, unknown>;
  /** Required in practice for a failed outcome. Missing means `adapter`. */
  failureClass?: FailureClass;
}

export interface RunnerEngine {
  run(job: EngineJob, hooks: EngineHooks): Promise<EngineResult>;
}
