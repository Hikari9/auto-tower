import { parseActivity } from '../../core/inputs.js';
import { DecisionNotFoundError } from '../../decisions/errors.js';
import {
  type AnswerInput,
  parseAnswer,
  parseCreateDecision,
  parseDecisionFilter,
  parseExpansion,
} from '../../decisions/inputs.js';
import type { RouteSpec } from '../app.js';
import { callerOf, commandContext, readJson } from './missions.js';
import { authorityGuarded, authorityOf } from './policy.js';

function decisionContext(c: Parameters<typeof callerOf>[0]) {
  const { correlationId } = commandContext(c);
  return { ...callerOf(c), correlationId };
}

const createDecision: RouteSpec = {
  method: 'post',
  path: '/decisions',
  access: { scopes: ['decision:write'] },
  handler: authorityGuarded(async (c) => {
    const input = parseCreateDecision(await readJson(c));
    const result = authorityOf(c).decisions.create(decisionContext(c), input);
    return c.json(result, result.created ? 201 : 200);
  }),
};

const listDecisions: RouteSpec = {
  method: 'get',
  path: '/decisions',
  access: { scopes: ['decision:read'] },
  handler: authorityGuarded((c) => {
    const filter = parseDecisionFilter(c.req.query());
    return c.json({
      decisions: authorityOf(c).decisions.list(callerOf(c).workspaceId, filter),
    });
  }),
};

const readDecision: RouteSpec = {
  method: 'get',
  path: '/decisions/:id',
  access: { scopes: ['decision:read'] },
  handler: authorityGuarded((c) => {
    const id = c.req.param('id') ?? '';
    const { workspaceId } = callerOf(c);
    const { decisions } = authorityOf(c);
    const decision = decisions.get(workspaceId, id);
    if (decision === undefined) {
      throw new DecisionNotFoundError(id);
    }
    return c.json({ decision, answers: decisions.answers(workspaceId, id) });
  }),
};

const answerDecision: RouteSpec = {
  method: 'post',
  path: '/decisions/:id/answers',
  access: { scopes: ['decision:write'] },
  handler: authorityGuarded(async (c) => {
    const answer: AnswerInput = parseAnswer(await readJson(c));
    return c.json(
      authorityOf(c).decisions.answer(
        decisionContext(c),
        c.req.param('id') ?? '',
        answer,
      ),
    );
  }),
};

const decisionHistory: RouteSpec = {
  method: 'get',
  path: '/decisions/:id/history',
  access: { scopes: ['decision:read'] },
  handler: authorityGuarded((c) =>
    c.json(
      authorityOf(c).decisions.history(
        callerOf(c).workspaceId,
        c.req.param('id') ?? '',
        parseActivity(c.req.query()),
      ),
    ),
  ),
};

/** Asks Tower to settle an expansion at the right tier. The caller can approve nothing by asking. */
const routeExpansion: RouteSpec = {
  method: 'post',
  path: '/expansions',
  access: { scopes: ['decision:write'] },
  handler: authorityGuarded(async (c) => {
    const input = parseExpansion(await readJson(c));
    const { workspaceId, actor } = callerOf(c);
    return c.json(
      authorityOf(c).routeExpansion({
        ...input,
        workspaceId,
        requester: actor,
        correlationId: commandContext(c).correlationId,
      }),
    );
  }),
};

export const decisionRoutes: readonly RouteSpec[] = [
  createDecision,
  listDecisions,
  readDecision,
  answerDecision,
  decisionHistory,
  routeExpansion,
];
