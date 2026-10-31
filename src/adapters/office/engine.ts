import type { Completion, DispatchContract } from '../../contracts/office-v1.ts';
import type { FailureClass } from '../../domain/types.ts';

/** A guarded effect the engine wants to perform (e.g. landing). The runner asks Tower first. */
export interface EffectRequest {
  key: string;
  action: string;
  resource: string;
  producerSessionId: string;
  review?: { status: 'approved' | 'changes_requested' | 'not_run'; reviewer: { id: string; sessionId: string; kind: 'agent' | 'human' | 'chief' }; independence: 'independent' | 'degraded'; sha?: string };
}

export type EngineStatus =
  | { state: 'running'; phase: string; checkpoint?: { portable: boolean; kind: 'branch' | 'artifact' | 'none'; ref?: string; sha?: string }; effect?: EffectRequest }
  | { state: 'succeeded'; completion: Completion }
  | { state: 'failed'; failure: { class: FailureClass; detail: string; retryable: boolean } };

/**
 * Office engine adapter, runner side. Implementations translate a Tower dispatch
 * contract into their native run and their native state back into receipts.
 * Versioned with the dispatch contract (tower.dispatch/v1).
 */
export interface OfficeEngine {
  readonly id: string;
  version(): Promise<string>;
  start(contract: DispatchContract): Promise<{ localRunId: string }>;
  poll(localRunId: string, contract: DispatchContract): Promise<EngineStatus>;
  /** Tower's answer to an EffectRequest. Denied effects must not happen. */
  effectResult(localRunId: string, key: string, allowed: boolean, reason: string): Promise<void>;
  cancel(localRunId: string, reason: string): Promise<void>;
  /** Stop gracefully and return a portable checkpoint if one exists. */
  pause(localRunId: string): Promise<{ portable: boolean; kind: 'branch' | 'artifact' | 'none'; ref?: string; sha?: string } | null>;
  /** Optional: serializable local state, persisted by the runner so a restart can re-attach. */
  snapshot?(localRunId: string): unknown;
  attach?(localRunId: string, state: unknown): void;
}
