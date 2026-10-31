import { createHash } from 'node:crypto';
import { RISKS } from '../../core/types.js';
import { InputReader, LIMITS } from '../../core/validation.js';
import {
  parseAnswer,
  parseDecisionFilter,
  parseExpansion,
} from '../../decisions/inputs.js';
import { ACTION_PATTERN } from '../../policy/actions.js';
import { asQuery, takeId } from '../args.js';
import type { ToolDefinition } from '../tool.js';
import { requireMission } from './missions.js';

const id = { type: 'string' } as const;

const EXPANSION_PROPERTIES = {
  missionId: id,
  packetId: { type: ['string', 'null'] },
  action: {
    type: 'string',
    description: 'Lower-case dotted action such as deploy.staging.',
  },
  resource: { type: 'string' },
  scope: { type: 'string' },
  risk: { enum: ['low', 'medium', 'high'] },
  amount: { type: ['integer', 'null'], minimum: 0 },
  question: { type: 'string' },
  dedupeKey: { type: 'string' },
  category: { type: 'string' },
  urgency: { enum: ['low', 'normal', 'high', 'urgent'] },
  alternatives: { type: 'array', items: { type: 'object' } },
  recommendation: { type: ['object', 'null'] },
  consequences: { type: 'string' },
  evidence: { type: 'array', items: { type: 'string' } },
  affectedScope: { type: 'array', items: { type: 'string' } },
  advisory: { type: 'object' },
} as const;

export const decisionTools: readonly ToolDefinition[] = [
  {
    name: 'list_decisions',
    title: 'List decisions',
    description: 'Lists Decision Inbox items, open ones first by urgency.',
    readOnly: true,
    scopes: ['decision:read'],
    properties: {
      status: { enum: ['open', 'answered', 'all'] },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
    },
    run(ctx, args) {
      const filter = parseDecisionFilter(asQuery(args));
      return {
        data: {
          decisions: ctx.services.authority.decisions.list(
            ctx.caller.workspaceId,
            filter,
          ),
        },
      };
    },
  },
  {
    name: 'answer_decision',
    title: 'Answer a decision',
    description:
      'Answers a Decision Inbox item. Only the authority the decision requires may answer: a chief of staff can answer only one a current delegated rule covers. An approval resumes only the branches blocked on this decision.',
    readOnly: false,
    scopes: ['decision:write'],
    properties: {
      decisionId: id,
      version: {
        type: 'integer',
        minimum: 1,
        description: 'Answer version. The highest wins.',
      },
      choice: {
        type: 'string',
        description: 'Id of one of the decision alternatives.',
      },
      note: { type: ['string', 'null'] },
    },
    required: ['decisionId', 'version', 'choice'],
    run(ctx, args, key) {
      const { id: decisionId, rest } = takeId(args, 'decisionId');
      const answer = parseAnswer(rest);
      const { workspaceId, actor, correlationId } = ctx.command(key);
      return {
        data: {
          ...ctx.services.authority.decisions.answer(
            { workspaceId, actor, correlationId },
            decisionId,
            answer,
          ),
        },
      };
    },
  },
  {
    name: 'request_expansion',
    title: 'Request an expansion',
    description:
      'Asks Tower to settle work beyond what a mission authorized. Inside approved scope it proceeds. A chief of staff is approved only under a current grant that covers the request. Anything else becomes a decision for the person who may answer. Asking approves nothing.',
    readOnly: false,
    scopes: ['decision:write'],
    properties: EXPANSION_PROPERTIES,
    required: ['missionId', 'action', 'resource', 'scope', 'risk', 'question'],
    run(ctx, args, key) {
      const input = parseExpansion(args);
      const { workspaceId, actor, correlationId } = ctx.command(key);
      return {
        data: {
          ...ctx.services.authority.routeExpansion({
            ...input,
            workspaceId,
            requester: actor,
            correlationId,
          }),
        },
      };
    },
  },
  {
    name: 'propose_policy_change',
    title: 'Propose a policy change',
    description:
      'Asks a person to consider a standing rule. Raises a decision for a human and changes no policy: it is not a grant. A person who agrees creates the grant with grant_policy. The mission named waits only on this one branch.',
    readOnly: false,
    scopes: ['decision:write'],
    properties: {
      missionId: id,
      packetId: { type: ['string', 'null'] },
      action: { type: 'string' },
      resource: { type: 'string' },
      scope: { type: 'string' },
      maxRisk: { enum: ['low', 'medium', 'high'] },
      rationale: { type: 'string' },
    },
    required: [
      'missionId',
      'action',
      'resource',
      'scope',
      'maxRisk',
      'rationale',
    ],
    run(ctx, args, key) {
      const r = new InputReader(args);
      const missionId = r.string('missionId', { max: 128, min: 1 });
      const packetId =
        r.optNullableString('packetId', { max: 128, min: 1 }) ?? null;
      const action = r.string('action', { max: 128, min: 1 });
      if (!ACTION_PATTERN.test(action)) {
        r.fail('action', 'must be lower-case dotted segments');
      }
      const resource = r.string('resource', { max: 256, min: 1 });
      const scope = r.string('scope', { max: 256, min: 1 });
      const maxRisk = r.enum('maxRisk', RISKS);
      const rationale = r.string('rationale', { max: LIMITS.text, min: 1 });
      r.finish();
      requireMission(ctx, missionId);
      const digest = createHash('sha256')
        .update(JSON.stringify([action, resource, scope, maxRisk]))
        .digest('hex')
        .slice(0, 40);
      const { workspaceId, actor, correlationId } = ctx.command(key);
      const created = ctx.services.authority.decisions.create(
        { workspaceId, actor, correlationId },
        {
          dedupeKey: `policy-proposal:${digest}`,
          category: 'novel',
          urgency: 'normal',
          question: `Create a standing grant for ${action} on ${resource} within ${scope}, up to ${maxRisk} risk?`,
          alternatives: [
            {
              id: 'approve',
              label: 'Agree to grant',
              description:
                'Agreeing grants nothing. A person still creates the rule, and every guarded effect is checked against policy when it happens.',
              consequence: null,
              resumes: true,
            },
            {
              id: 'decline',
              label: 'Decline',
              description: null,
              consequence: null,
              resumes: false,
            },
          ],
          recommendation: { alternativeId: 'approve', rationale },
          consequences: 'No policy changes unless a person creates the grant.',
          requiredAuthority: 'human',
          evidence: [],
          affectedScope: [scope],
          request: null,
          advisory: { confidencePercent: null },
          branches: [{ missionId, packetId }],
        },
      );
      return {
        data: {
          decision: created.decision,
          created: created.created,
          grants: 'nothing',
        },
      };
    },
  },
];
