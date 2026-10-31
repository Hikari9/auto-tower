import { CoreError } from '../core/errors.js';

/** A refusal by the authority layer. `status` is the HTTP status a route answers with. */
export abstract class AuthorityError extends CoreError {
  abstract readonly status: 403 | 404 | 409 | 422;
}

/** The acting principal's kind may not make this change to authority. */
export class AuthorityForbiddenError extends AuthorityError {
  override readonly name = 'AuthorityForbiddenError';
  readonly code = 'forbidden_actor';
  readonly status = 403;

  constructor(
    readonly command: string,
    readonly actorKind: string,
  ) {
    super(`A ${actorKind} principal may not ${command}`);
  }
}

/** A guarded effect was not allowed. Carries the evaluation that said so. */
export class PolicyDeniedError extends AuthorityError {
  override readonly name = 'PolicyDeniedError';
  readonly code = 'policy_denied';
  readonly status = 403;

  constructor(
    readonly effect: string,
    readonly reason: string,
    readonly policyRef: string,
  ) {
    super(`The action is not authorized: ${reason}`);
  }
}

export class RuleNotFoundError extends AuthorityError {
  override readonly name = 'RuleNotFoundError';
  readonly code = 'rule_not_found';
  readonly status = 404;

  constructor(readonly ruleId: string) {
    super(`Policy rule ${ruleId} was not found`);
  }
}

export class ProposalNotFoundError extends AuthorityError {
  override readonly name = 'ProposalNotFoundError';
  readonly code = 'proposal_not_found';
  readonly status = 404;

  constructor(readonly proposalId: string) {
    super(`Proposal ${proposalId} was not found`);
  }
}

/** The change does not apply to the rule or proposal in its current state. */
export class RuleStateError extends AuthorityError {
  override readonly name = 'RuleStateError';
  readonly code = 'rule_state';
  readonly status = 409;

  constructor(message: string) {
    super(message);
  }
}

/** A narrowing that is not narrower than what the proposal described. */
export class WideningError extends AuthorityError {
  override readonly name = 'WideningError';
  readonly code = 'widening_rejected';
  readonly status = 422;

  constructor(readonly field: string) {
    super(`${field} must be the same as or narrower than the proposal`);
  }
}
