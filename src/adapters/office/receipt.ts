import { type FailureClass, isFailureClass } from '../../runner/failure.js';
import { assertOfficeContract, ContractError } from './contract.js';

export type Risk = 'low' | 'medium' | 'high';

/** The completion receipt an Office run returns for one packet. Unknown fields are ignored. */
export interface OfficeReceipt {
  contract: string;
  kind: 'receipt';
  receiptId: string;
  correlationId: string;
  runId: string;
  outcome: 'succeeded' | 'failed';
  summary: string;
  executor: { id: string };
  /** The engine's own check of its work. Never independent review. */
  selfVerification: { result: 'passed' | 'failed'; by: string } | null;
  independentReview: {
    reviewer: string;
    result: 'approved' | 'rejected';
  } | null;
  integratedVerification: {
    result: 'passed' | 'failed';
    testsRun: number;
    commitSha: string | null;
  } | null;
  failure: { class: FailureClass | null; message: string } | null;
  residualRisks: string[];
}

const RECEIPT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_SUMMARY = 4_000;
const MAX_RISKS = 50;

type Json = Record<string, unknown>;

function invalid(path: string, message: string): ContractError {
  return new ContractError('invalid', `receipt ${path} ${message}`);
}

function object(value: unknown, path: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(path, 'must be an object');
  }
  return value as Json;
}

function optionalObject(value: unknown, path: string): Json | null {
  return value === undefined || value === null ? null : object(value, path);
}

function text(value: unknown, path: string, max: number, min = 1): string {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw invalid(path, `must be a string of ${min} to ${max} characters`);
  }
  return value;
}

function clipped(value: unknown, path: string, max: number): string {
  if (typeof value !== 'string') {
    throw invalid(path, 'must be a string');
  }
  return value.slice(0, max);
}

function oneOf<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): T {
  if (
    typeof value !== 'string' ||
    !(allowed as readonly string[]).includes(value)
  ) {
    throw invalid(path, `must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

function count(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw invalid(path, 'must be a non-negative integer');
  }
  return value;
}

/**
 * Reads a receipt from an untrusted body. The contract id is checked first, so a newer major is
 * refused as `unsupported_major` before any field is read.
 */
export function parseOfficeReceipt(value: unknown): OfficeReceipt {
  const o = object(value, 'body');
  assertOfficeContract(o.contract);
  if (o.kind !== 'receipt') {
    throw invalid('kind', 'must be "receipt"');
  }
  const receiptId = text(o.receiptId, 'receiptId', 128);
  if (!RECEIPT_ID.test(receiptId)) {
    throw invalid('receiptId', 'may only contain letters, digits, . _ : -');
  }
  const selfVerification = optionalObject(
    o.selfVerification,
    'selfVerification',
  );
  const review = optionalObject(o.independentReview, 'independentReview');
  const integrated = optionalObject(
    o.integratedVerification,
    'integratedVerification',
  );
  const failure = optionalObject(o.failure, 'failure');
  const commit = integrated?.commitSha ?? null;
  if (commit !== null && (typeof commit !== 'string' || !COMMIT.test(commit))) {
    throw invalid(
      'integratedVerification.commitSha',
      'must be a full lowercase hex commit id',
    );
  }
  // Long free text is clipped, not refused: a completed run must not turn into an adapter failure.
  const residual = o.residualRisks ?? [];
  if (!Array.isArray(residual)) {
    throw invalid(
      'residualRisks',
      `must be an array of at most ${MAX_RISKS} strings`,
    );
  }
  return {
    contract: text(o.contract, 'contract', 64),
    kind: 'receipt',
    receiptId,
    correlationId: text(o.correlationId, 'correlationId', 128),
    runId: text(o.runId, 'runId', 128),
    outcome: oneOf(o.outcome, 'outcome', ['succeeded', 'failed'] as const),
    summary:
      o.summary === undefined ? '' : clipped(o.summary, 'summary', MAX_SUMMARY),
    executor: {
      id: text(object(o.executor, 'executor').id, 'executor.id', 128),
    },
    selfVerification:
      selfVerification === null
        ? null
        : {
            result: oneOf(selfVerification.result, 'selfVerification.result', [
              'passed',
              'failed',
            ] as const),
            by: text(selfVerification.by, 'selfVerification.by', 128),
          },
    independentReview:
      review === null
        ? null
        : {
            reviewer: text(review.reviewer, 'independentReview.reviewer', 128),
            result: oneOf(review.result, 'independentReview.result', [
              'approved',
              'rejected',
            ] as const),
          },
    integratedVerification:
      integrated === null
        ? null
        : {
            result: oneOf(integrated.result, 'integratedVerification.result', [
              'passed',
              'failed',
            ] as const),
            testsRun: count(
              integrated.testsRun,
              'integratedVerification.testsRun',
            ),
            commitSha: commit,
          },
    failure:
      failure === null
        ? null
        : {
            // An engine class this runner does not know is an adapter failure, not an unclassified one.
            class: isFailureClass(failure.class) ? failure.class : null,
            message:
              failure.message === undefined
                ? ''
                : text(failure.message, 'failure.message', MAX_SUMMARY, 0),
          },
    residualRisks: residual
      .slice(0, MAX_RISKS)
      .map((risk, i) => clipped(risk, `residualRisks[${i}]`, 500)),
  };
}

/** What Tower took from a receipt. Identity comparisons are already done here. */
export interface ReceiptFacts {
  outcome: 'succeeded' | 'failed';
  selfVerification: 'passed' | 'failed' | 'absent';
  independentReview: 'satisfied' | 'self-reviewed' | 'rejected' | 'missing';
  reviewerId: string | null;
  integratedVerification: 'passed' | 'failed' | 'absent';
  /** Set for a failed outcome only. */
  failureClass: FailureClass | null;
}

/** Identities compare without case or surrounding space, so `Bot ` and `bot` are one principal. */
export function sameIdentity(a: string, b: string): boolean {
  return identityKey(a) === identityKey(b);
}

/**
 * Folds an identity to one form: compatibility characters composed, invisible format and control
 * characters removed, then case and surrounding space ignored. A zero-width space in a reviewer
 * name therefore still names the producer. Look-alike letters from other scripts are not folded.
 */
function identityKey(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .trim()
    .toLowerCase();
}

/**
 * Reads the facts of one receipt. A reviewer whose identity equals any producer identity is
 * recorded as `self-reviewed`, which satisfies nothing. The producers are Tower's runner principal
 * and the engine's own executor id, since either could be the same session as the reviewer.
 */
export function factsOf(
  receipt: OfficeReceipt,
  producerIds: readonly string[],
): ReceiptFacts {
  const producers = [...producerIds, receipt.executor.id];
  const review = receipt.independentReview;
  const selfVerification = receipt.selfVerification?.result ?? 'absent';
  const integrated = receipt.integratedVerification?.result ?? 'absent';
  let independentReview: ReceiptFacts['independentReview'] = 'missing';
  if (review !== null) {
    if (producers.some((p) => sameIdentity(p, review.reviewer))) {
      independentReview = 'self-reviewed';
    } else {
      independentReview =
        review.result === 'approved' ? 'satisfied' : 'rejected';
    }
  }
  return {
    outcome: receipt.outcome,
    selfVerification,
    independentReview,
    reviewerId: review?.reviewer ?? null,
    integratedVerification: integrated,
    failureClass:
      receipt.outcome === 'failed'
        ? (receipt.failure?.class ??
          defaultFailureClass(selfVerification, integrated, independentReview))
        : null,
  };
}

function defaultFailureClass(
  self: ReceiptFacts['selfVerification'],
  integrated: ReceiptFacts['integratedVerification'],
  review: ReceiptFacts['independentReview'],
): FailureClass {
  if (self === 'failed' || integrated === 'failed') {
    return 'implementation-defect';
  }
  if (
    review === 'rejected' ||
    review === 'self-reviewed' ||
    review === 'missing'
  ) {
    return 'review-failure';
  }
  return 'adapter';
}

/**
 * Whether this receipt alone satisfies what the risk level needs. Green tests and a successful
 * outcome are not enough on high risk: an independent review and an integrated verification are
 * both required.
 */
export function isReady(facts: ReceiptFacts, risk: Risk): boolean {
  if (facts.outcome !== 'succeeded' || facts.selfVerification !== 'passed') {
    return false;
  }
  if (risk !== 'high') {
    return true;
  }
  return (
    facts.independentReview === 'satisfied' &&
    facts.integratedVerification === 'passed'
  );
}
