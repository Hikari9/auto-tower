import type { CompletionGuardRegistry } from '../core/guards.js';
import { createPolicyService, type PolicyService } from '../policy/service.js';
import type { SqlDatabase } from '../storage/database.js';
import {
  createExpansionRouter,
  type ExpansionOutcome,
  type ExpansionRequest,
} from './expansion.js';
import { createDecisionInbox, type DecisionInbox } from './inbox.js';

export * from './errors.js';
export type {
  ExpansionOutcome,
  ExpansionRequest,
} from './expansion.js';
export type {
  AnswerResult,
  CreateResult,
  DecisionContext,
  DecisionInbox,
} from './inbox.js';
export * from './types.js';

export interface AuthorityDependencies {
  db: SqlDatabase;
  /** The mission core's guard registry, shared so a resumed branch passes the same checks. */
  guards: CompletionGuardRegistry;
  clock?: () => Date;
  newId?: (prefix: string) => string;
}

/** The authority layer over one database: policy store, Decision Inbox and tier routing. */
export interface Authority {
  policy: PolicyService;
  decisions: DecisionInbox;
  /** Settles an expansion request at the tier the spec assigns it. See `ExpansionOutcome`. */
  routeExpansion(request: ExpansionRequest): ExpansionOutcome;
}

export function createAuthority(deps: AuthorityDependencies): Authority {
  const optional = {
    ...(deps.clock === undefined ? {} : { clock: deps.clock }),
    ...(deps.newId === undefined ? {} : { newId: deps.newId }),
  };
  return {
    policy: createPolicyService({ db: deps.db, ...optional }),
    decisions: createDecisionInbox({
      db: deps.db,
      guards: deps.guards,
      ...optional,
    }),
    routeExpansion: createExpansionRouter({
      db: deps.db,
      guards: deps.guards,
      ...optional,
    }),
  };
}
