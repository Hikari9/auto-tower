/**
 * Typed fleet refusals. `code` is stable and maps to a status in the route layer. An error that
 * carries `audit` is written to the audit after the failed transaction has rolled back, so a
 * refusal is recorded even though it changed nothing else.
 */
export interface AuditDraft {
  kind: string;
  runnerId?: string | null;
  leaseId?: string | null;
  actorId?: string | null;
  detail?: Record<string, unknown>;
}

export class FleetError extends Error {
  override readonly name = 'FleetError';

  constructor(
    readonly code: FleetErrorCode,
    message: string,
    readonly audit?: AuditDraft,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export type FleetErrorCode =
  | 'enrollment_invalid'
  | 'version_mismatch'
  | 'version_unsupported'
  | 'runner_required'
  | 'human_required'
  | 'credential_not_bound'
  | 'runner_quarantined'
  | 'runner_not_found'
  | 'lease_not_found'
  | 'lease_fenced'
  | 'lease_expired'
  | 'lease_closed'
  | 'attempt_cancelled'
  | 'receipt_conflict'
  | 'progress_conflict';
