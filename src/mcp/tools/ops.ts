import { InputReader } from '../../core/validation.js';
import {
  engageHalt,
  haltHistory,
  healthReport,
  liftHalt,
} from '../../ops/index.js';
import type { ToolDefinition } from '../tool.js';

const REASON_MAX = 500;

export const opsTools: readonly ToolDefinition[] = [
  {
    name: 'read_health',
    title: 'Read operational health',
    description:
      'Reports whether the workspace is running, halted or degraded, with each active signal, what it means and what to do about it. Read-only.',
    readOnly: true,
    scopes: ['mission:read'],
    properties: {},
    run(ctx, args) {
      new InputReader(args).finish();
      const { workspaceId } = ctx.caller;
      return {
        data: {
          health: healthReport(ctx.services.db, workspaceId),
          haltHistory: haltHistory(ctx.services.db, workspaceId, {
            afterSeq: 0,
            limit: 20,
          }),
        },
      };
    },
  },
  {
    name: 'halt_workspace',
    title: 'Emergency halt',
    description:
      'Stops new dispatch and every guarded effect for the workspace at once. Nothing is deleted or rewritten: missions, attempts, leases, decisions and policy stay as they are, and `resume_workspace` picks up where it stopped. Only a person can halt.',
    readOnly: false,
    scopes: ['policy:write'],
    material: true,
    effect:
      'Stops new dispatch and guarded effects such as closing provider issues, until a person resumes.',
    properties: { reason: { type: ['string', 'null'], maxLength: REASON_MAX } },
    run(ctx, args) {
      const r = new InputReader(args);
      const reason = r.optString('reason', { max: REASON_MAX, min: 1 }) ?? null;
      r.finish();
      return {
        data: {
          halt: engageHalt(ctx.services.db, {
            workspaceId: ctx.caller.workspaceId,
            actor: ctx.caller.actor,
            reason,
            now: ctx.services.now(),
          }),
        },
      };
    },
  },
  {
    name: 'resume_workspace',
    title: 'Lift the emergency halt',
    description:
      'Lifts a halt. Dispatch and guarded effects run again under the policy as it stands now, so a rule revoked during the halt stays revoked. Only a person can resume.',
    readOnly: false,
    scopes: ['policy:write'],
    material: true,
    effect: 'Lets dispatch and guarded effects run again.',
    properties: { reason: { type: ['string', 'null'], maxLength: REASON_MAX } },
    run(ctx, args) {
      const r = new InputReader(args);
      const reason = r.optString('reason', { max: REASON_MAX, min: 1 }) ?? null;
      r.finish();
      return {
        data: {
          halt: liftHalt(ctx.services.db, {
            workspaceId: ctx.caller.workspaceId,
            actor: ctx.caller.actor,
            reason,
            now: ctx.services.now(),
          }),
        },
      };
    },
  },
];
