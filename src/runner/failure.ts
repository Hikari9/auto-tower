import { TransportError } from './transport.js';
/**
 * Why a unit of work failed. Every failed receipt carries exactly one class, so a human reading
 * the mission can tell a broken machine from a broken implementation.
 */
export const FAILURE_CLASSES = [
  /** The machine or its tools are missing or misconfigured. Retrying here will not help. */
  'environment',
  /** The runner failed: transport loss, a process it could not supervise, a refused write. */
  'runner',
  /** The engine adapter failed: unknown output, unsupported contract, unparseable receipt. */
  'adapter',
  /** The engine or provider is out of quota or rate limited. Retry later. */
  'quota',
  /** Tower's authority rules refused the action. A grant or decision is needed. */
  'policy-denial',
  /** Independent review rejected the work, or none could be recorded. */
  'review-failure',
  /** The work was done and checked, and the checks found a defect in the work itself. */
  'implementation-defect',
] as const;

export type FailureClass = (typeof FAILURE_CLASSES)[number];

export function isFailureClass(value: unknown): value is FailureClass {
  return (
    typeof value === 'string' &&
    (FAILURE_CLASSES as readonly string[]).includes(value)
  );
}

/** An error an engine or the runner throws with its class already decided. */
export class ClassifiedFailure extends Error {
  override readonly name = 'ClassifiedFailure';

  constructor(
    readonly failureClass: FailureClass,
    message: string,
  ) {
    super(message);
  }
}

/** Maps an error that escaped a run to a class. Anything unclassified is the adapter's fault. */
export function classifyError(error: unknown): FailureClass {
  if (error instanceof ClassifiedFailure) {
    return error.failureClass;
  }
  // A lost connection is the runner's failure, and a retry can succeed.
  if (error instanceof TransportError) {
    return 'runner';
  }
  return 'adapter';
}
