import { InputReader } from '../../core/validation.js';
import { parseCreateRule, parseRevoke } from '../../policy/inputs.js';
import { takeId } from '../args.js';
import { McpToolError } from '../errors.js';
import {
  createFlagServiceFor,
  FEATURE_FLAGS,
  isFeatureFlag,
} from '../flags.js';
import type { ToolDefinition } from '../tool.js';

const AUDIT_SOURCES = ['feature_flags', 'tool_calls'] as const;

const ruleBody = {
  action: {
    type: 'string',
    description: 'Action pattern, such as deploy.staging or issue.close.',
  },
  resource: { type: 'string' },
  scope: { type: 'string' },
  maxRisk: { enum: ['low', 'medium', 'high'] },
  grantee: {
    type: 'object',
    description:
      'Who holds the grant: { kind } for a principal kind, or { principalId } for one principal.',
  },
  limits: { type: 'object', description: '{ maxAmount, missionIds }' },
  expiresAt: { type: ['string', 'null'] },
  note: { type: ['string', 'null'] },
} as const;

export const policyTools: readonly ToolDefinition[] = [
  {
    name: 'read_policy',
    title: 'Read policy',
    description:
      'Returns the policy version, active rules and pending grant proposals. Preferences are shown for context and never change an evaluation.',
    readOnly: true,
    scopes: ['policy:read'],
    properties: {},
    run(ctx) {
      const { workspaceId } = ctx.caller;
      const { policy } = ctx.services.authority;
      return {
        data: {
          policyVersion: policy.policyVersion(workspaceId),
          rules: policy.listRules(workspaceId, { status: 'active' }),
          preferences: policy.listPreferences(workspaceId),
          proposals: policy.listProposals(workspaceId, 'pending'),
        },
      };
    },
  },
  {
    name: 'grant_policy',
    title: 'Grant authority',
    description:
      'Creates a standing allow rule. Only a person can. A grant lets the named principal act inside the pattern without asking, until it expires or is revoked.',
    readOnly: false,
    scopes: ['policy:write'],
    material: true,
    effect: 'Creates an allow rule that takes effect immediately.',
    properties: ruleBody,
    required: ['action', 'resource', 'scope', 'grantee'],
    run(ctx, args, key) {
      // This tool only grants. A deny rule is a different act and is not reachable from here.
      const input = parseCreateRule({ ...args, effect: 'allow' });
      const result = ctx.services.authority.policy.createRule(
        ctx.command(key),
        input,
      );
      return { data: { ...result } };
    },
  },
  {
    name: 'revoke_policy',
    title: 'Revoke authority',
    description:
      'Revokes a rule. It blocks the next guarded effect immediately, including work already in flight.',
    readOnly: false,
    scopes: ['policy:write'],
    material: true,
    effect: 'Revokes the rule at once.',
    properties: {
      ruleId: { type: 'string' },
      expectedVersion: { type: 'integer', minimum: 1 },
      reason: { type: ['string', 'null'] },
    },
    required: ['ruleId', 'expectedVersion'],
    run(ctx, args, key) {
      const { id, rest } = takeId(args, 'ruleId');
      const { expectedVersion, reason } = parseRevoke(rest);
      return {
        data: {
          ...ctx.services.authority.policy.revokeRule(
            ctx.command(key),
            id,
            expectedVersion,
            reason,
          ),
        },
      };
    },
  },
  {
    name: 'read_feature_flags',
    title: 'Read feature flags',
    description:
      'Shows cloud_ai.triage and hosted_execution. Both are off until a person approves a provider, a budget and a policy.',
    readOnly: true,
    scopes: ['policy:read'],
    properties: {},
    run(ctx) {
      return {
        data: {
          flags: createFlagServiceFor(ctx.services).read(
            ctx.caller.workspaceId,
          ),
        },
      };
    },
  },
  {
    name: 'read_audit',
    title: 'Read the audit trail',
    description:
      'Reads append-only history. `feature_flags` lists every flag change with who made it, the old and new setting and the rule it named. `tool_calls` lists MCP tool calls and their outcomes, without arguments or results. Pages by `afterSeq`.',
    readOnly: true,
    scopes: ['policy:read'],
    properties: {
      source: { enum: AUDIT_SOURCES },
      afterSeq: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
    },
    required: ['source'],
    run(ctx, args) {
      const r = new InputReader(args);
      const source = r.enum('source', AUDIT_SOURCES);
      const afterSeq =
        r.optInteger('afterSeq', { min: 0, max: Number.MAX_SAFE_INTEGER }) ?? 0;
      const limit = r.optInteger('limit', { min: 1, max: 200 }) ?? 50;
      r.finish();
      const { workspaceId } = ctx.caller;
      if (source === 'feature_flags') {
        return {
          data: {
            source,
            records: createFlagServiceFor(ctx.services).history(workspaceId, {
              afterSeq,
              limit,
            }),
          },
        };
      }
      const records = ctx.services.db
        .all<{
          seq: number;
          principal_id: string;
          session_id: string | null;
          tool: string;
          mutating: number;
          outcome: string;
          error_code: string | null;
          recorded_at: string;
        }>(
          `SELECT seq, principal_id, session_id, tool, mutating, outcome, error_code, recorded_at
           FROM mcp_audit WHERE workspace_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
          [workspaceId, afterSeq, limit],
        )
        .map((row) => ({
          seq: row.seq,
          principalId: row.principal_id,
          sessionId: row.session_id,
          tool: row.tool,
          mutating: row.mutating === 1,
          outcome: row.outcome,
          errorCode: row.error_code,
          recordedAt: row.recorded_at,
        }));
      return { data: { source, records } };
    },
  },
  {
    name: 'set_feature_flag',
    title: 'Set a feature flag',
    description:
      'Turns a flag on or off. Only a person can. Turning one on without an approved provider, a positive budget in cents and an active delegated rule is refused.',
    readOnly: false,
    scopes: ['policy:write'],
    material: true,
    effect: 'Changes whether the flagged capability may run.',
    properties: {
      flag: { enum: FEATURE_FLAGS },
      enabled: { type: 'boolean' },
      providerId: { type: ['string', 'null'] },
      budgetCents: { type: ['integer', 'null'], minimum: 1 },
      policyRuleId: { type: ['string', 'null'] },
    },
    required: ['flag', 'enabled'],
    run(ctx, args) {
      // The schema allows null for an unset budget. The reader takes a number or nothing.
      const { budgetCents: givenBudget, ...others } = args;
      const r = new InputReader(
        givenBudget === null ? others : { ...others, budgetCents: givenBudget },
      );
      const flag = r.string('flag', { max: 64, min: 1 });
      if (!isFeatureFlag(flag)) {
        throw new McpToolError(
          'validation_failed',
          `flag must be one of ${FEATURE_FLAGS.join(', ')}`,
        );
      }
      const enabled = r.optBoolean('enabled');
      if (enabled === undefined) {
        r.fail('enabled', 'is required');
      }
      const input = {
        flag,
        enabled: enabled ?? false,
        providerId:
          r.optNullableString('providerId', { max: 128, min: 1 }) ?? null,
        budgetCents: r.optInteger('budgetCents', { min: 1, max: 1e12 }) ?? null,
        policyRuleId:
          r.optNullableString('policyRuleId', { max: 128, min: 1 }) ?? null,
      };
      r.finish();
      return {
        data: {
          flag: createFlagServiceFor(ctx.services).set(ctx.command(), input),
        },
      };
    },
  },
];
