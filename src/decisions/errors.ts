import { AuthorityError } from '../policy/errors.js';

export class DecisionNotFoundError extends AuthorityError {
  override readonly name = 'DecisionNotFoundError';
  readonly code = 'decision_not_found';
  readonly status = 404;

  constructor(readonly decisionId: string) {
    super(`Decision ${decisionId} was not found`);
  }
}

/** The dedupe key names an open decision about something else. */
export class DedupeConflictError extends AuthorityError {
  override readonly name = 'DedupeConflictError';
  readonly code = 'dedupe_conflict';
  readonly status = 409;

  constructor(readonly dedupeKey: string) {
    super(
      `Dedupe key ${dedupeKey} belongs to an open decision about a different request`,
    );
  }
}

/** A second answer at the same version that says something different. */
export class AnswerConflictError extends AuthorityError {
  override readonly name = 'AnswerConflictError';
  readonly code = 'answer_conflict';
  readonly status = 409;

  constructor(
    readonly decisionId: string,
    readonly version: number,
  ) {
    super(
      `Decision ${decisionId} already has a different answer at version ${version}`,
    );
  }
}

/** A Chief of Staff answered without a current delegated rule that covers the request. */
export class DelegationRequiredError extends AuthorityError {
  override readonly name = 'DelegationRequiredError';
  readonly code = 'delegation_required';
  readonly status = 403;

  constructor(
    readonly decisionId: string,
    readonly reason: string,
  ) {
    super(
      `Decision ${decisionId} needs a person, or a current delegated rule: ${reason}`,
    );
  }
}
