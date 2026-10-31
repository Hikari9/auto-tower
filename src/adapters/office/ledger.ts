import type { SqlDatabase } from '../../storage/database.js';
import {
  factsOf,
  isReady,
  type OfficeReceipt,
  type ReceiptFacts,
  type Risk,
} from './receipt.js';

/** A receipt for this attempt, or this receipt id, already holds a different verdict. */
export class ReceiptConflictError extends Error {
  override readonly name = 'ReceiptConflictError';
  readonly code = 'receipt_conflict';
}

export interface IngestInput {
  workspaceId: string;
  missionId: string;
  packetId: string;
  attemptId: string;
  /** Tower's runner principal for the attempt. The engine's executor id is added to these. */
  producerIds: readonly string[];
  risk: Risk;
  receipt: OfficeReceipt;
  recordedAt: string;
}

export interface IngestResult {
  /** True when this exact receipt was already ingested. Nothing was written. */
  replayed: boolean;
  facts: ReceiptFacts;
  /** Whether this receipt alone satisfies the risk level it was ingested at. */
  ready: boolean;
}

const RECEIPT_COLUMNS = `receipt_id, packet_id, attempt_id, outcome, self_verification,
  independent_review, reviewer_id, integrated_verification, failure_class`;

interface ReceiptRow {
  receipt_id: string;
  packet_id: string;
  attempt_id: string;
  outcome: 'succeeded' | 'failed';
  self_verification: ReceiptFacts['selfVerification'];
  independent_review: ReceiptFacts['independentReview'];
  reviewer_id: string | null;
  integrated_verification: ReceiptFacts['integratedVerification'];
  failure_class: ReceiptFacts['failureClass'];
}

function factsOfRow(row: ReceiptRow): ReceiptFacts {
  return {
    outcome: row.outcome,
    selfVerification: row.self_verification,
    independentReview: row.independent_review,
    reviewerId: row.reviewer_id,
    integratedVerification: row.integrated_verification,
    failureClass: row.failure_class,
  };
}

/**
 * Records what Tower judged from one Office receipt. Ingesting the same receipt again is a replay
 * that writes nothing. A different receipt for an attempt that already has one is refused.
 */
export function ingestOfficeReceipt(
  db: SqlDatabase,
  input: IngestInput,
): IngestResult {
  const { receipt } = input;
  if (receipt.correlationId !== input.attemptId) {
    throw new ReceiptConflictError(
      `Office receipt ${receipt.receiptId} is for another attempt`,
    );
  }
  return db.transaction((tx) => {
    const sameAttempt = tx.get<ReceiptRow>(
      `SELECT ${RECEIPT_COLUMNS} FROM office_receipts WHERE workspace_id = ? AND attempt_id = ?`,
      [input.workspaceId, input.attemptId],
    );
    if (sameAttempt !== undefined) {
      if (sameAttempt.receipt_id !== receipt.receiptId) {
        throw new ReceiptConflictError(
          `attempt ${input.attemptId} already has a different Office receipt`,
        );
      }
      const stored = factsOfRow(sameAttempt);
      const incoming = factsOf(receipt, input.producerIds);
      // Same id but a different verdict is a different receipt, so it is refused, not replayed.
      if (JSON.stringify(stored) !== JSON.stringify(incoming)) {
        throw new ReceiptConflictError(
          `Office receipt ${receipt.receiptId} was already recorded with a different verdict`,
        );
      }
      return {
        replayed: true,
        facts: stored,
        ready: isReady(stored, input.risk),
      };
    }
    const sameId = tx.get<{ attempt_id: string }>(
      'SELECT attempt_id FROM office_receipts WHERE workspace_id = ? AND receipt_id = ?',
      [input.workspaceId, receipt.receiptId],
    );
    if (sameId !== undefined) {
      throw new ReceiptConflictError(
        `Office receipt ${receipt.receiptId} is already recorded for another attempt`,
      );
    }
    const facts = factsOf(receipt, input.producerIds);
    tx.run(
      `INSERT INTO office_receipts (
         workspace_id, receipt_id, mission_id, packet_id, attempt_id, outcome,
         self_verification, independent_review, reviewer_id, integrated_verification,
         failure_class, recorded_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.workspaceId,
        receipt.receiptId,
        input.missionId,
        input.packetId,
        input.attemptId,
        facts.outcome,
        facts.selfVerification,
        facts.independentReview,
        facts.reviewerId,
        facts.integratedVerification,
        facts.failureClass,
        input.recordedAt,
      ],
    );
    return { replayed: false, facts, ready: isReady(facts, input.risk) };
  });
}

export const OFFICE_REVIEW_GUARD = 'office-high-risk-review';

type GuardVerdict = { ok: true } | { ok: false; reason: string };

/** The part of a mission the guard reads. Structural, so the adapter needs no core import. */
export interface ReviewGuardContext {
  mission: {
    id: string;
    workspaceId: string;
    risk: string;
    packets: ReadonlyArray<{ id: string; required: boolean }>;
    /** Every attempt the mission has run. The latest attempt per packet is the one that counts. */
    attempts: ReadonlyArray<{ id: string; packetId: string; number: number }>;
  };
}

/**
 * On a high-risk mission, every required packet needs an Office receipt that carries an
 * independent review and an integrated verification, both satisfied by someone other than the
 * producer. Lower-risk missions pass here, since the core guards already require verified packets.
 * Register it on the core's completion guard registry.
 */
export function createOfficeReviewGuard(db: SqlDatabase): {
  name: string;
  check(context: ReviewGuardContext): GuardVerdict;
} {
  return {
    name: OFFICE_REVIEW_GUARD,
    check({ mission }) {
      if (mission.risk !== 'high') {
        return { ok: true };
      }
      const rows = db.all<ReceiptRow>(
        `SELECT ${RECEIPT_COLUMNS} FROM office_receipts WHERE workspace_id = ? AND mission_id = ?`,
        [mission.workspaceId, mission.id],
      );
      // A packet's receipt counts only for its latest attempt. An earlier attempt that was rejected and
      // requeued does not satisfy the gate for the work that replaced it.
      const latest = new Map<string, { id: string; number: number }>();
      for (const attempt of mission.attempts) {
        const current = latest.get(attempt.packetId);
        if (current === undefined || attempt.number > current.number) {
          latest.set(attempt.packetId, {
            id: attempt.id,
            number: attempt.number,
          });
        }
      }
      const ready = new Set(
        rows
          .filter(
            (row) =>
              isReady(factsOfRow(row), 'high') &&
              latest.get(row.packet_id)?.id === row.attempt_id,
          )
          .map((row) => row.packet_id),
      );
      const required = mission.packets
        .filter((packet) => packet.required)
        .map((packet) => packet.id);
      if (required.length === 0) {
        return ready.size > 0
          ? { ok: true }
          : {
              ok: false,
              reason:
                'high-risk mission has no Office receipt with independent review and integrated verification',
            };
      }
      const missing = required.filter((id) => !ready.has(id));
      return missing.length === 0
        ? { ok: true }
        : {
            ok: false,
            reason: `high-risk packets lack an Office receipt with independent review and integrated verification: ${missing.join(', ')}`,
          };
    },
  };
}
