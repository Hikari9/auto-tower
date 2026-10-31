import type { SqlDatabase } from '../../storage/database.js';
import { ContractError } from './contract.js';
import { ingestOfficeReceipt, ReceiptConflictError } from './ledger.js';
import { parseOfficeReceipt, type Risk } from './receipt.js';

/**
 * What became of the Office verdict in a receipt a runner sent. The runner's receipt itself is
 * stored either way. This says whether Tower also read it as an Office receipt, so the runner is
 * told when it did not, instead of getting the same answer for both.
 */
export type OfficeIngest =
  /** The body does not claim the Office contract, so no verdict was expected. */
  | { status: 'not_office' }
  | { status: 'ingested'; replayed: boolean }
  | {
      status: 'not_ingested';
      reason:
        | 'invalid_receipt'
        | 'unsupported_contract'
        | 'conflict'
        | 'failed';
      message: string;
    };

export interface OfficeEvidence {
  workspaceId: string;
  missionId: string;
  packetId: string;
  attemptId: string;
  risk: Risk;
  /** The runner principal that sent the receipt. */
  callerId: string;
  /** The stored `evidence` of the runner's receipt. */
  evidence: unknown;
  recordedAt: string;
}

/**
 * Every runner that held this attempt, across reassignments, plus the sender. Each of them
 * produced some of the work, so none may later stand as its independent reviewer.
 */
export function producersOfAttempt(
  db: SqlDatabase,
  workspaceId: string,
  attemptId: string,
  callerId: string,
): string[] {
  const held = db.all<{ runner_id: string }>(
    `SELECT runner_id FROM runner_leases WHERE workspace_id = ? AND attempt_id = ?
     UNION
     SELECT runner_id FROM execution_attempts WHERE workspace_id = ? AND id = ?`,
    [workspaceId, attemptId, workspaceId, attemptId],
  );
  return [...new Set([callerId, ...held.map((row) => row.runner_id)])];
}

const claimsOffice = (evidence: unknown): boolean => {
  const contract = (evidence as { contract?: unknown } | null | undefined)
    ?.contract;
  return typeof contract === 'string' && contract.startsWith('tower.office.');
};

/**
 * Parses the receipt's Office contract and records the verdict. Never throws for a bad receipt:
 * the outcome says why nothing was ingested, with no content from the body.
 */
export function ingestOfficeEvidence(
  db: SqlDatabase,
  input: OfficeEvidence,
): OfficeIngest {
  if (!claimsOffice(input.evidence)) {
    return { status: 'not_office' };
  }
  let receipt: ReturnType<typeof parseOfficeReceipt>;
  try {
    receipt = parseOfficeReceipt(input.evidence);
  } catch (error) {
    if (error instanceof ContractError) {
      return {
        status: 'not_ingested',
        reason:
          error.code === 'invalid' ? 'invalid_receipt' : 'unsupported_contract',
        message: error.message.slice(0, 300),
      };
    }
    return {
      status: 'not_ingested',
      reason: 'invalid_receipt',
      message: 'The receipt could not be read.',
    };
  }
  try {
    const result = ingestOfficeReceipt(db, {
      workspaceId: input.workspaceId,
      missionId: input.missionId,
      packetId: input.packetId,
      attemptId: input.attemptId,
      producerIds: producersOfAttempt(
        db,
        input.workspaceId,
        input.attemptId,
        input.callerId,
      ),
      risk: input.risk,
      receipt,
      recordedAt: input.recordedAt,
    });
    return { status: 'ingested', replayed: result.replayed };
  } catch (error) {
    if (error instanceof ReceiptConflictError) {
      return {
        status: 'not_ingested',
        reason: 'conflict',
        message: error.message.slice(0, 300),
      };
    }
    return {
      status: 'not_ingested',
      reason: 'failed',
      message: 'The verdict could not be recorded. Send the receipt again.',
    };
  }
}
