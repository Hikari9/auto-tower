import { CoreError } from '../core/errors.js';

/** A refusal by the issue layer. `status` is the HTTP status a route answers with. */
export abstract class IssueError extends CoreError {
  abstract readonly status: 403 | 404 | 409;
}

export class IssueLinkNotFoundError extends IssueError {
  override readonly name = 'IssueLinkNotFoundError';
  readonly code = 'issue_link_not_found';
  readonly status = 404;

  constructor(readonly ref: string) {
    super(`Issue link ${ref} was not found on this mission`);
  }
}

export class DiscrepancyNotFoundError extends IssueError {
  override readonly name = 'DiscrepancyNotFoundError';
  readonly code = 'discrepancy_not_found';
  readonly status = 404;

  constructor(readonly discrepancyId: string) {
    super(`Discrepancy ${discrepancyId} was not found`);
  }
}

/** The acting principal's kind may not do this. */
export class IssueForbiddenError extends IssueError {
  override readonly name = 'IssueForbiddenError';
  readonly code = 'forbidden_actor';
  readonly status = 403;

  constructor(
    readonly command: string,
    readonly actorKind: string,
  ) {
    super(`A ${actorKind} principal may not ${command}`);
  }
}

/** The request is valid but the link, mission or configuration does not allow it now. */
export class IssueStateError extends IssueError {
  override readonly name = 'IssueStateError';
  readonly code: string;
  readonly status = 409;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
