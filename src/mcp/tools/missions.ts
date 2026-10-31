import { RiskLoweringRefusedError } from '../../core/commands.js';
import { MissionNotFoundError } from '../../core/errors.js';
import {
  parseCancel,
  parseCreateMission,
  parseSearch,
  parseTransition,
  parseUpdateMission,
} from '../../core/inputs.js';
import type { CommandResult } from '../../core/service.js';
import { InputReader } from '../../core/validation.js';
import { authorityHoldsFor } from '../../fleet/broker.js';
import { createPolicyService } from '../../policy/service.js';
import { asQuery, takeId } from '../args.js';
import type { ToolContext, ToolDefinition } from '../tool.js';

/** The response shape the HTTP API uses for every command. */
export function commandData(result: CommandResult): Record<string, unknown> {
  return {
    mission: result.mission,
    event: {
      seq: result.event.seq,
      version: result.event.version,
      type: result.event.type,
      correlationId: result.event.correlationId,
    },
    replayed: result.replayed,
  };
}

export function requireMission(ctx: ToolContext, id: string) {
  const mission = ctx.services.core.missions.getMission(
    ctx.caller.workspaceId,
    id,
  );
  if (mission === undefined) {
    throw new MissionNotFoundError(id);
  }
  return mission;
}

/**
 * Records a refused risk lowering as a deny receipt, as the HTTP route does. The command rolled
 * back, so the receipt is written on its own.
 */
function recordRiskRefusal(
  ctx: ToolContext,
  missionId: string,
  error: RiskLoweringRefusedError,
): void {
  const { db, now } = ctx.services;
  const { workspaceId, actor } = ctx.caller;
  try {
    const policyVersion = createPolicyService({ db }).policyVersion(
      workspaceId,
    );
    db.run(
      `INSERT INTO policy_receipts (workspace_id, principal_id, action, resource, scope, risk, mission_id,
       effect, code, reason, rule_id, rule_version, policy_version, evaluated_at)
     VALUES (?, ?, 'mission.risk.lower', ?, 'risk', ?, ?, 'deny', ?, ?, NULL, NULL, ?, ?)`,
      [
        workspaceId,
        actor.id,
        `mission:${missionId}`,
        error.from,
        missionId,
        error.code,
        error.message,
        policyVersion,
        now().toISOString(),
      ],
    );
  } catch (auditError) {
    console.error(
      `risk refusal receipt not recorded: ${auditError instanceof Error ? auditError.name : 'error'}`,
    );
  }
}

const MISSION_FIELDS = {
  title: { type: 'string', maxLength: 200 },
  intent: { type: 'string' },
  outcome: {
    type: 'string',
    description: 'What must be true when the mission is done.',
  },
  constraints: { type: 'array', items: { type: 'string' } },
  risk: { enum: ['low', 'medium', 'high'] },
  size: { enum: ['xs', 's', 'm', 'l', 'xl'] },
  priority: { enum: ['low', 'normal', 'high', 'urgent'] },
  definitionOfDone: {
    type: 'array',
    items: {
      type: 'object',
      properties: { text: { type: 'string' }, done: { type: 'boolean' } },
      required: ['text'],
    },
  },
  links: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        classification: { enum: ['required', 'optional', 'reference-only'] },
        title: { type: ['string', 'null'] },
      },
      required: ['url', 'classification'],
    },
  },
  policyRefs: { type: 'array', items: { type: 'string' } },
} as const;

const missionId = { type: 'string', description: 'Mission id.' } as const;
const expectedVersion = {
  type: 'integer',
  minimum: 1,
  description:
    'Version of the mission you last read. A stale value is refused.',
} as const;

export const missionTools: readonly ToolDefinition[] = [
  {
    name: 'create_mission',
    title: 'Create a mission',
    description:
      'Creates a durable mission in draft. Needs title, intent and outcome. Reuse the same idempotencyKey to retry safely.',
    readOnly: false,
    scopes: ['mission:write'],
    properties: {
      ...MISSION_FIELDS,
      source: { type: 'string', maxLength: 64 },
      parentId: { type: ['string', 'null'] },
      requiredForParent: { type: 'boolean' },
    },
    required: ['title', 'intent', 'outcome'],
    run(ctx, args, key) {
      const input = parseCreateMission({ source: 'mcp', ...args });
      return {
        data: commandData(
          ctx.services.core.missions.createMission(ctx.command(key), input),
        ),
      };
    },
  },
  {
    name: 'search_missions',
    title: 'Search missions',
    description:
      'Finds missions by text, state, parent, priority or risk, newest activity first.',
    readOnly: true,
    scopes: ['mission:read'],
    properties: {
      q: { type: 'string', maxLength: 200 },
      state: { type: 'array', items: { type: 'string' } },
      parentId: { type: 'string' },
      priority: MISSION_FIELDS.priority,
      risk: MISSION_FIELDS.risk,
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      offset: { type: 'integer', minimum: 0 },
    },
    run(ctx, args) {
      const query = parseSearch(asQuery(args));
      return {
        data: {
          ...ctx.services.core.missions.search(ctx.caller.workspaceId, query),
        },
      };
    },
  },
  {
    name: 'read_mission',
    title: 'Read a mission',
    description:
      'Returns one mission with its packets, attempts, links and verification.',
    readOnly: true,
    scopes: ['mission:read'],
    properties: { missionId },
    required: ['missionId'],
    run(ctx, args) {
      const { id, rest } = takeId(args, 'missionId');
      new InputReader(rest).finish();
      const mission = requireMission(ctx, id);
      const { db, now } = ctx.services;
      // Claim-time authority refusals still holding a branch, as the HTTP route reports them.
      return {
        data: {
          mission,
          holds: authorityHoldsFor(db, now, ctx.caller.workspaceId, mission),
        },
      };
    },
  },
  {
    name: 'update_mission',
    title: 'Update a mission',
    description:
      'Changes descriptive fields of a mission. Discards any outcome verification. Needs expectedVersion and at least one field.',
    readOnly: false,
    scopes: ['mission:write'],
    properties: { missionId, expectedVersion, ...MISSION_FIELDS },
    required: ['missionId', 'expectedVersion'],
    run(ctx, args, key) {
      const { id, rest } = takeId(args, 'missionId');
      const parsed = parseUpdateMission(rest);
      try {
        return {
          data: commandData(
            ctx.services.core.missions.updateMission(
              ctx.command(key),
              id,
              parsed.expectedVersion,
              parsed.changes,
            ),
          ),
        };
      } catch (error) {
        if (error instanceof RiskLoweringRefusedError) {
          recordRiskRefusal(ctx, id, error);
        }
        throw error;
      }
    },
  },
  {
    name: 'close_mission',
    title: 'Close a mission',
    description:
      'Closes a mission. outcome "completed" moves a verifying mission to completed and runs every completion guard, so an unverified outcome, an unclosed required issue or a missing independent review blocks it. outcome "cancelled" cancels Tower\'s mission and touches nothing outside Tower.',
    readOnly: false,
    scopes: ['mission:write'],
    material: true,
    effect: 'Moves the mission to its final state.',
    properties: {
      missionId,
      expectedVersion,
      outcome: { enum: ['completed', 'cancelled'] },
      reason: { type: 'string', maxLength: 1000 },
    },
    required: ['missionId', 'expectedVersion', 'outcome'],
    run(ctx, args, key) {
      const { id, rest } = takeId(args, 'missionId');
      const { outcome, ...body } = rest;
      const r = new InputReader({ outcome });
      const closing = r.enum('outcome', ['completed', 'cancelled'] as const);
      r.finish();
      const missions = ctx.services.core.missions;
      if (closing === 'cancelled') {
        const { expectedVersion: version, reason } = parseCancel(body);
        return {
          data: commandData(
            missions.cancelMission(ctx.command(key), id, version, reason),
          ),
        };
      }
      const { expectedVersion: version, reason } = parseTransition({
        ...body,
        to: 'completed',
      });
      return {
        data: commandData(
          missions.transitionMission(
            ctx.command(key),
            id,
            version,
            'completed',
            reason,
          ),
        ),
      };
    },
  },
];
