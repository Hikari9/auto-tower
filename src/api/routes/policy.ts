import type { Context } from 'hono';
import { ValidationError } from '../../core/errors.js';
import { parseActivity } from '../../core/inputs.js';
import { type Authority, createAuthority } from '../../decisions/index.js';
import { AuthorityError, PolicyDeniedError } from '../../policy/errors.js';
import {
  PREFERENCE_KEY,
  parseAmendRule,
  parseCreateRule,
  parseEvaluation,
  parseNarrow,
  parseNote,
  parsePreference,
  parseRevoke,
} from '../../policy/inputs.js';
import { PROPOSAL_STATUSES, type ProposalStatus } from '../../policy/types.js';
import type { AppDependencies, AppEnv, RouteSpec } from '../app.js';
import {
  callerOf,
  commandContext,
  coreOf,
  guarded,
  readJson,
} from './missions.js';

type RouteHandler = (c: Context<AppEnv>) => Response | Promise<Response>;

const authorities = new WeakMap<AppDependencies, Authority>();

/** The authority layer for this app. Built over the same core and clock unless the host supplied one. */
export function authorityOf(c: Context<AppEnv>): Authority {
  const deps = c.get('deps');
  if (deps.authority !== undefined) {
    return deps.authority;
  }
  let authority = authorities.get(deps);
  if (authority === undefined) {
    authority = createAuthority({
      db: deps.db,
      guards: coreOf(c).guards,
      ...(deps.now === undefined ? {} : { clock: deps.now }),
    });
    authorities.set(deps, authority);
  }
  return authority;
}

/** Maps authority refusals to their status, then leaves everything else to the shared guard. */
export function authorityGuarded(handler: RouteHandler): RouteHandler {
  return guarded(async (c) => {
    try {
      return await handler(c);
    } catch (error) {
      if (error instanceof AuthorityError) {
        return c.json(
          {
            error: {
              code: error.code,
              message: error.message,
              ...(error instanceof PolicyDeniedError
                ? { details: { policyRef: error.policyRef } }
                : {}),
            },
          },
          error.status,
        );
      }
      throw error;
    }
  });
}

function parseStatusFilter<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ValidationError([
      { path: 'status', message: `must be one of ${allowed.join(', ')}` },
    ]);
  }
  return value as T;
}

const readPolicy: RouteSpec = {
  method: 'get',
  path: '/policy',
  access: { scopes: ['policy:read'] },
  handler: authorityGuarded((c) => {
    const { workspaceId } = callerOf(c);
    const { policy } = authorityOf(c);
    return c.json({
      policyVersion: policy.policyVersion(workspaceId),
      rules: policy.listRules(workspaceId, { status: 'active' }),
      preferences: policy.listPreferences(workspaceId),
      proposals: policy.listProposals(workspaceId, 'pending'),
    });
  }),
};

const listRules: RouteSpec = {
  method: 'get',
  path: '/policy/rules',
  access: { scopes: ['policy:read'] },
  handler: authorityGuarded((c) => {
    const { workspaceId } = callerOf(c);
    const { policy } = authorityOf(c);
    const status = parseStatusFilter(c.req.query('status'), [
      'active',
      'inactive',
      'all',
    ] as const);
    return c.json({
      policyVersion: policy.policyVersion(workspaceId),
      rules: policy.listRules(workspaceId, { status: status ?? 'all' }),
    });
  }),
};

const readRule: RouteSpec = {
  method: 'get',
  path: '/policy/rules/:id',
  access: { scopes: ['policy:read'] },
  handler: authorityGuarded((c) => {
    const id = c.req.param('id') ?? '';
    const rule = authorityOf(c).policy.getRule(callerOf(c).workspaceId, id);
    if (rule === undefined) {
      return c.json(
        {
          error: {
            code: 'rule_not_found',
            message: `Policy rule ${id} was not found`,
          },
        },
        404,
      );
    }
    return c.json({ rule });
  }),
};

const createRule: RouteSpec = {
  method: 'post',
  path: '/policy/rules',
  access: { scopes: ['policy:write'] },
  handler: authorityGuarded(async (c) => {
    const input = parseCreateRule(await readJson(c));
    const result = authorityOf(c).policy.createRule(commandContext(c), input);
    return c.json(result, result.replayed ? 200 : 201);
  }),
};

const amendRule: RouteSpec = {
  method: 'patch',
  path: '/policy/rules/:id',
  access: { scopes: ['policy:write'] },
  handler: authorityGuarded(async (c) => {
    const { expectedVersion, changes } = parseAmendRule(await readJson(c));
    return c.json(
      authorityOf(c).policy.amendRule(
        commandContext(c),
        c.req.param('id') ?? '',
        expectedVersion,
        changes,
      ),
    );
  }),
};

const revokeRule: RouteSpec = {
  method: 'post',
  path: '/policy/rules/:id/revoke',
  access: { scopes: ['policy:write'] },
  handler: authorityGuarded(async (c) => {
    const { expectedVersion, reason } = parseRevoke(await readJson(c));
    return c.json(
      authorityOf(c).policy.revokeRule(
        commandContext(c),
        c.req.param('id') ?? '',
        expectedVersion,
        reason,
      ),
    );
  }),
};

const policyHistory: RouteSpec = {
  method: 'get',
  path: '/policy/history',
  access: { scopes: ['policy:read'] },
  handler: authorityGuarded((c) =>
    c.json(
      authorityOf(c).policy.history(
        callerOf(c).workspaceId,
        parseActivity(c.req.query()),
      ),
    ),
  ),
};

const ruleHistory: RouteSpec = {
  method: 'get',
  path: '/policy/rules/:id/history',
  access: { scopes: ['policy:read'] },
  handler: authorityGuarded((c) =>
    c.json(
      authorityOf(c).policy.history(
        callerOf(c).workspaceId,
        parseActivity(c.req.query()),
        { ruleId: c.req.param('id') ?? '' },
      ),
    ),
  ),
};

/** A dry run. It records nothing, and answers for the caller unless another principal is named. */
const evaluateRequest: RouteSpec = {
  method: 'post',
  path: '/policy/evaluations',
  access: { scopes: ['policy:read'] },
  handler: authorityGuarded(async (c) => {
    const input = parseEvaluation(await readJson(c));
    const { workspaceId, actor } = callerOf(c);
    return c.json({
      evaluation: authorityOf(c).policy.authorize({
        workspace: workspaceId,
        principal: input.principalId ?? actor.id,
        action: input.action,
        resource: input.resource,
        scope: input.scope,
        risk: input.risk,
        amount: input.amount,
        missionId: input.missionId,
        attemptId: input.attemptId,
      }),
    });
  }),
};

const readReceipts: RouteSpec = {
  method: 'get',
  path: '/policy/receipts',
  access: { scopes: ['policy:read'] },
  handler: authorityGuarded((c) => {
    const { afterVersion, limit } = parseActivity(c.req.query());
    const receipts = authorityOf(c).policy.receipts(callerOf(c).workspaceId, {
      afterSeq: afterVersion,
      limit,
    });
    return c.json({
      receipts,
      nextAfter:
        receipts.length === limit
          ? (receipts[receipts.length - 1]?.seq ?? null)
          : null,
    });
  }),
};

const listPreferences: RouteSpec = {
  method: 'get',
  path: '/policy/preferences',
  access: { scopes: ['policy:read'] },
  handler: authorityGuarded((c) =>
    c.json({
      preferences: authorityOf(c).policy.listPreferences(
        callerOf(c).workspaceId,
      ),
    }),
  ),
};

const setPreference: RouteSpec = {
  method: 'put',
  path: '/policy/preferences/:key',
  access: { scopes: ['policy:write'] },
  handler: authorityGuarded(async (c) => {
    const key = c.req.param('key') ?? '';
    if (!PREFERENCE_KEY.test(key)) {
      throw new ValidationError([
        {
          path: 'key',
          message: 'must be 1 to 128 letters, digits or . _ : / -',
        },
      ]);
    }
    const value = parsePreference(await readJson(c));
    return c.json({
      preference: authorityOf(c).policy.setPreference(
        commandContext(c),
        key,
        value,
      ),
    });
  }),
};

const listProposals: RouteSpec = {
  method: 'get',
  path: '/policy/proposals',
  access: { scopes: ['policy:read'] },
  handler: authorityGuarded((c) => {
    const status: ProposalStatus | undefined = parseStatusFilter(
      c.req.query('status'),
      PROPOSAL_STATUSES,
    );
    return c.json({
      proposals: authorityOf(c).policy.listProposals(
        callerOf(c).workspaceId,
        status,
      ),
    });
  }),
};

const readProposal: RouteSpec = {
  method: 'get',
  path: '/policy/proposals/:id',
  access: { scopes: ['policy:read'] },
  handler: authorityGuarded((c) => {
    const id = c.req.param('id') ?? '';
    const { policy } = authorityOf(c);
    const proposal = policy.getProposal(callerOf(c).workspaceId, id);
    if (proposal === undefined) {
      return c.json(
        {
          error: {
            code: 'proposal_not_found',
            message: `Proposal ${id} was not found`,
          },
        },
        404,
      );
    }
    return c.json({
      proposal,
      history: policy.history(
        callerOf(c).workspaceId,
        { afterVersion: 0, limit: 200 },
        { proposalId: id },
      ).items,
    });
  }),
};

const acceptProposal: RouteSpec = {
  method: 'post',
  path: '/policy/proposals/:id/accept',
  access: { scopes: ['policy:write'] },
  handler: authorityGuarded(async (c) => {
    const { note } = parseNote(await readJson(c));
    return c.json(
      authorityOf(c).policy.acceptProposal(
        commandContext(c),
        c.req.param('id') ?? '',
        note,
      ),
    );
  }),
};

const narrowProposal: RouteSpec = {
  method: 'post',
  path: '/policy/proposals/:id/narrow',
  access: { scopes: ['policy:write'] },
  handler: authorityGuarded(async (c) =>
    c.json(
      authorityOf(c).policy.narrowProposal(
        commandContext(c),
        c.req.param('id') ?? '',
        parseNarrow(await readJson(c)),
      ),
    ),
  ),
};

const declineProposal: RouteSpec = {
  method: 'post',
  path: '/policy/proposals/:id/decline',
  access: { scopes: ['policy:write'] },
  handler: authorityGuarded(async (c) => {
    const { note } = parseNote(await readJson(c));
    return c.json({
      proposal: authorityOf(c).policy.declineProposal(
        commandContext(c),
        c.req.param('id') ?? '',
        note,
      ),
    });
  }),
};

export const policyRoutes: readonly RouteSpec[] = [
  readPolicy,
  listRules,
  readRule,
  createRule,
  amendRule,
  revokeRule,
  policyHistory,
  ruleHistory,
  evaluateRequest,
  readReceipts,
  listPreferences,
  setPreference,
  listProposals,
  readProposal,
  acceptProposal,
  narrowProposal,
  declineProposal,
];
