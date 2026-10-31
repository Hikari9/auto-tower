import { ATTEMPT_STATUSES, type AttemptStatus } from '../../core/types.js';
import { InputReader } from '../../core/validation.js';
import type { ToolDefinition } from '../tool.js';

interface AttemptRow {
  id: string;
  mission_id: string;
  packet_id: string;
  number: number;
  runner_id: string;
  status: AttemptStatus;
  dispatched_at: string;
  started_at: string | null;
  reported_at: string | null;
  reported_by: string | null;
}

export const fleetTools: readonly ToolDefinition[] = [
  {
    name: 'list_runners',
    title: 'List runners',
    description:
      'Lists enrolled runners with status, capabilities and current load. A runner principal sees only itself.',
    readOnly: true,
    scopes: ['runner:read'],
    properties: {},
    run(ctx, args) {
      new InputReader(args).finish();
      const { workspaceId, actor } = ctx.caller;
      return {
        data: {
          runners: ctx.services.fleet.runners(
            workspaceId,
            actor.kind === 'runner' ? actor.id : undefined,
          ),
        },
      };
    },
  },
  {
    name: 'list_runs',
    title: 'List runs',
    description:
      'Lists execution attempts, newest first. An attempt records what a runner claimed. A claim is not verification: only packet and mission verification count. A runner principal sees only its own attempts.',
    readOnly: true,
    scopes: ['mission:read'],
    properties: {
      missionId: { type: 'string' },
      status: { enum: ATTEMPT_STATUSES },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
    },
    run(ctx, args) {
      const r = new InputReader(args);
      const missionId = r.optString('missionId', { max: 128, min: 1 });
      const status = r.optEnum('status', ATTEMPT_STATUSES);
      const limit = r.optInteger('limit', { min: 1, max: 200 }) ?? 50;
      r.finish();
      // A runner reads its own attempts only: the others show other runners' work and claims.
      const ownRunner =
        ctx.caller.actor.kind === 'runner' ? ctx.caller.actor.id : null;
      const rows = ctx.services.db.all<AttemptRow>(
        `SELECT id, mission_id, packet_id, number, runner_id, status, dispatched_at, started_at, reported_at, reported_by
         FROM execution_attempts
         WHERE workspace_id = ?
           AND (? IS NULL OR runner_id = ?)
           AND (? IS NULL OR mission_id = ?)
           AND (? IS NULL OR status = ?)
         ORDER BY dispatched_at DESC, id DESC LIMIT ?`,
        [
          ctx.caller.workspaceId,
          ownRunner,
          ownRunner,
          missionId ?? null,
          missionId ?? null,
          status ?? null,
          status ?? null,
          limit,
        ],
      );
      return {
        data: {
          runs: rows.map((row) => ({
            id: row.id,
            missionId: row.mission_id,
            packetId: row.packet_id,
            number: row.number,
            runnerId: row.runner_id,
            status: row.status,
            selfReported:
              row.status === 'self-reported-succeeded' ||
              row.status === 'self-reported-failed',
            dispatchedAt: row.dispatched_at,
            startedAt: row.started_at,
            reportedAt: row.reported_at,
            reportedBy: row.reported_by,
          })),
        },
      };
    },
  },
];
