import type { Core } from '../core/index.js';
import { newId } from '../shared/ids.js';
import type { SqlDatabase } from '../storage/database.js';
import { createFleetPool } from './broker.js';
import { defaultFleetConfig, type FleetConfig } from './config.js';
import { createTransact, type FleetContext } from './context.js';
import {
  type IssuedEnrollment,
  type IssueEnrollment,
  issueEnrollment,
  type Registration,
  register,
} from './enrollment.js';
import { FleetError } from './errors.js';
import type { RegisterInput } from './inputs.js';
import {
  type CheckpointResult,
  type ClaimResult,
  claim,
  type HeartbeatResult,
  type HumanCaller,
  heartbeat,
  type ProgressResult,
  quarantine,
  type ReceiptResult,
  type ReconcileResult,
  type RunnerCaller,
  reconcile,
  recordCheckpoint,
  recordProgress,
  recordReceipt,
  releaseLease,
  releaseOffer,
  sweepWorkspace,
  tickWorkspace,
  unquarantine,
  updateRunner,
} from './leases.js';
import {
  type AuditRecord,
  getLease,
  getRunner,
  type Lease,
  type LeaseStatus,
  listLeases,
  listRunners,
  publicRunner,
  type Runner,
  readAudit,
  runnerLoad,
} from './store.js';

export * from './broker.js';
export * from './config.js';
export * from './errors.js';
export type {
  Assignment,
  ClaimResult,
  Directives,
  HeartbeatResult,
  LeaseView,
  RunnerCaller,
} from './leases.js';
export { redactString, redactValue } from './redact.js';
export * from './scope.js';
export type { Lease, Runner } from './store.js';
export * from './version.js';

export interface FleetDependencies {
  db: SqlDatabase;
  /** Supplies the mission service and the scheduler the poll runs. Wire `createFleetPool` into it. */
  core: Core;
  now?: () => Date;
  config?: FleetConfig;
  newId?: (prefix: string) => string;
}

export interface LeaseDetail {
  lease: Lease;
  progress: Array<{
    seq: number;
    fence: number;
    message: string;
    data: unknown;
    recordedAt: string;
  }>;
  checkpoints: Array<{
    id: string;
    fence: number;
    ref: string;
    commit: string | null;
    recordedAt: string;
  }>;
  receipts: Array<{
    receiptId: string;
    outcome: string;
    summary: string;
    evidence: unknown;
    recordedAt: string;
  }>;
}

export interface Fleet {
  config: FleetConfig;
  issueEnrollment(input: IssueEnrollment): IssuedEnrollment;
  register(
    caller: { workspaceId: string; tokenId: string },
    input: RegisterInput,
  ): Registration;
  claim(caller: RunnerCaller, input: Parameters<typeof claim>[2]): ClaimResult;
  heartbeat(
    caller: RunnerCaller,
    input: Parameters<typeof heartbeat>[2],
  ): HeartbeatResult;
  progress(
    caller: RunnerCaller,
    leaseId: string,
    input: Parameters<typeof recordProgress>[3],
  ): ProgressResult;
  checkpoint(
    caller: RunnerCaller,
    leaseId: string,
    input: Parameters<typeof recordCheckpoint>[3],
  ): CheckpointResult;
  receipt(
    caller: RunnerCaller,
    leaseId: string,
    input: Parameters<typeof recordReceipt>[3],
  ): ReceiptResult;
  reconcile(
    caller: RunnerCaller,
    leaseId: string,
    input: Parameters<typeof reconcile>[3],
  ): ReconcileResult;
  updateRunner(
    caller: HumanCaller,
    runnerId: string,
    input: Parameters<typeof updateRunner>[3],
  ): ReturnType<typeof publicRunner>;
  quarantine(
    caller: HumanCaller,
    runnerId: string,
    reason: string | null,
  ): ReturnType<typeof publicRunner>;
  unquarantine(
    caller: HumanCaller,
    runnerId: string,
  ): ReturnType<typeof publicRunner>;
  releaseLease(
    caller: HumanCaller,
    leaseId: string,
    reason: string | null,
  ): Lease;
  releaseOffer(
    caller: HumanCaller,
    attemptId: string,
    reason: string | null,
  ): ReturnType<typeof releaseOffer>;
  /** All runners in the workspace, or only `onlyId`. */
  runners(
    workspaceId: string,
    onlyId?: string,
  ): Array<ReturnType<typeof publicRunner>>;
  leases(
    workspaceId: string,
    query: { status: LeaseStatus | undefined; limit: number },
  ): Lease[];
  leaseDetail(
    workspaceId: string,
    leaseId: string,
    viewer: { principalId: string; kind: string },
  ): LeaseDetail;
  audit(
    workspaceId: string,
    query: { afterSeq: number; limit: number },
  ): AuditRecord[];
  /** Brings lease state up to date with the clock. Every operation does this itself. */
  sweep(workspaceId: string): void;
  /** Sweeps, then schedules, with no runner poll involved. Hosts call it on a timer. */
  tick(workspaceId: string): void;
}

export function createFleet(deps: FleetDependencies): Fleet {
  const now = deps.now ?? (() => new Date());
  const config = deps.config ?? defaultFleetConfig();
  const ctx: FleetContext = {
    db: deps.db,
    core: deps.core,
    config,
    now,
    ids: deps.newId ?? newId,
    transact: createTransact(deps.db, now),
  };
  const view = (runner: Runner) =>
    publicRunner(runner, runnerLoad(deps.db, runner.workspaceId, runner.id));

  return {
    config,
    issueEnrollment: (input) => issueEnrollment(ctx, input),
    register: (caller, input) => register(ctx, caller, input),
    claim: (caller, input) => claim(ctx, caller, input),
    heartbeat: (caller, input) => heartbeat(ctx, caller, input),
    progress: (caller, id, input) => recordProgress(ctx, caller, id, input),
    checkpoint: (caller, id, input) => recordCheckpoint(ctx, caller, id, input),
    receipt: (caller, id, input) => recordReceipt(ctx, caller, id, input),
    reconcile: (caller, id, input) => reconcile(ctx, caller, id, input),
    updateRunner: (caller, id, input) =>
      view(updateRunner(ctx, caller, id, input)),
    quarantine: (caller, id, reason) =>
      view(quarantine(ctx, caller, id, reason)),
    unquarantine: (caller, id) => view(unquarantine(ctx, caller, id)),
    releaseLease: (caller, id, reason) => releaseLease(ctx, caller, id, reason),
    releaseOffer: (caller, id, reason) => releaseOffer(ctx, caller, id, reason),

    runners(workspaceId, onlyId) {
      if (onlyId !== undefined) {
        const runner = getRunner(deps.db, workspaceId, onlyId);
        return runner === undefined ? [] : [view(runner)];
      }
      return listRunners(deps.db, workspaceId).map(view);
    },
    leases(workspaceId, query) {
      sweepWorkspace(ctx, workspaceId);
      return listLeases(deps.db, workspaceId, query);
    },
    leaseDetail(workspaceId, leaseId, viewer) {
      sweepWorkspace(ctx, workspaceId);
      const lease = getLease(deps.db, workspaceId, leaseId);
      // A runner sees only its own leases, and cannot tell another's from a missing one.
      if (
        lease === undefined ||
        (viewer.kind === 'runner' && lease.runnerId !== viewer.principalId)
      ) {
        throw new FleetError('lease_not_found', 'No such lease');
      }
      return {
        lease,
        progress: deps.db
          .all<{
            seq: number;
            fence: number;
            message: string;
            data_json: string;
            recorded_at: string;
          }>(
            'SELECT seq, fence, message, data_json, recorded_at FROM runner_progress WHERE workspace_id = ? AND lease_id = ? ORDER BY seq',
            [workspaceId, leaseId],
          )
          .map((r) => ({
            seq: r.seq,
            fence: r.fence,
            message: r.message,
            data: JSON.parse(r.data_json) as unknown,
            recordedAt: r.recorded_at,
          })),
        checkpoints: deps.db
          .all<{
            id: string;
            fence: number;
            ref: string;
            commit_sha: string | null;
            recorded_at: string;
          }>(
            'SELECT id, fence, ref, commit_sha, recorded_at FROM runner_checkpoints WHERE workspace_id = ? AND lease_id = ? ORDER BY seq',
            [workspaceId, leaseId],
          )
          .map((r) => ({
            id: r.id,
            fence: r.fence,
            ref: r.ref,
            commit: r.commit_sha,
            recordedAt: r.recorded_at,
          })),
        receipts: deps.db
          .all<{
            receipt_id: string;
            outcome: string;
            summary: string;
            evidence_json: string;
            recorded_at: string;
          }>(
            'SELECT receipt_id, outcome, summary, evidence_json, recorded_at FROM runner_receipts WHERE workspace_id = ? AND lease_id = ? ORDER BY recorded_at, receipt_id',
            [workspaceId, leaseId],
          )
          .map((r) => ({
            receiptId: r.receipt_id,
            outcome: r.outcome,
            summary: r.summary,
            evidence: JSON.parse(r.evidence_json) as unknown,
            recordedAt: r.recorded_at,
          })),
      };
    },
    audit: (workspaceId, query) => readAudit(deps.db, workspaceId, query),
    sweep: (workspaceId) => sweepWorkspace(ctx, workspaceId),
    tick: (workspaceId) => tickWorkspace(ctx, workspaceId),
  };
}

/** The scheduler's runner pool backed by this database. Give it to `createCore` so a tick dispatches to real runners. */
export function createPool(deps: {
  db: SqlDatabase;
  now?: () => Date;
  config?: FleetConfig;
}) {
  return createFleetPool({
    db: deps.db,
    config: deps.config ?? defaultFleetConfig(),
    now: deps.now ?? (() => new Date()),
  });
}
