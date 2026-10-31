import { ValidationError } from '../../core/errors.js';
import type { MissionState, MissionStatus } from '../../core/types.js';
import { InputReader } from '../../core/validation.js';
import type { ToolContext, ToolDefinition } from '../tool.js';
import { requireMission } from './missions.js';

/** States that need a person or a runner before anything else happens. */
const ATTENTION: readonly MissionStatus[] = [
  'needs-attention',
  'waiting-decision',
  'waiting-runner',
  'waiting-external',
  'reconciling',
  'verifying',
];
const MAX_ATTENTION = 25;
const QUESTION_PREVIEW = 300;

function blockerOf(mission: MissionState): string {
  const failed = mission.packets.filter((p) => p.status === 'failed');
  switch (mission.state) {
    case 'waiting-runner':
      return 'Authorized work is ready and no runner has taken it.';
    case 'waiting-decision':
      return 'A branch waits for a decision or an authorization.';
    case 'waiting-external':
      return 'Waiting on something outside Tower.';
    case 'reconciling':
      return 'A linked issue drifted from what Tower recorded.';
    case 'verifying':
      return 'Work is done and awaits outcome verification and the completion guards.';
    default:
      return failed.length > 0
        ? `Failed packets: ${failed.map((p) => p.id).join(', ')}.`
        : 'A person put this mission in needs-attention.';
  }
}

function briefing(ctx: ToolContext): Record<string, unknown> {
  const { db, core, authority } = ctx.services;
  const { workspaceId, scopes } = ctx.caller;
  const counts = db.all<{ state: string; n: number }>(
    'SELECT state, COUNT(*) AS n FROM missions WHERE workspace_id = ? GROUP BY state',
    [workspaceId],
  );
  const attention = core.missions.search(workspaceId, {
    states: ATTENTION,
    limit: MAX_ATTENTION,
    offset: 0,
  });
  const blockers = attention.items
    .filter((item) => item.state !== 'verifying')
    .flatMap((item) => {
      const mission = core.missions.getMission(workspaceId, item.id);
      return mission === undefined
        ? []
        : [
            {
              missionId: mission.id,
              title: mission.title,
              state: mission.state,
              priority: mission.priority,
              blocker: blockerOf(mission),
            },
          ];
    });
  const open = scopes.includes('decision:read')
    ? authority.decisions
        .list(workspaceId, { status: 'open', limit: 50 })
        .map((d) => ({
          id: d.id,
          category: d.category,
          urgency: d.urgency,
          requiredAuthority: d.requiredAuthority,
          question: d.question.slice(0, QUESTION_PREVIEW),
          blockedBranches: d.links.filter((l) => l.status === 'blocked').length,
          createdAt: d.createdAt,
        }))
    : undefined;
  return {
    missions: {
      byState: Object.fromEntries(counts.map((c) => [c.state, c.n])),
      needingAttention: attention.items,
      attentionTotal: attention.total,
    },
    blockers,
    // Omitted, not empty, for a caller without decision:read, so absence is not read as "none".
    ...(open === undefined ? {} : { decisions: { open } }),
  };
}

export const briefingTools: readonly ToolDefinition[] = [
  {
    name: 'briefing',
    title: 'Briefing',
    description:
      'Summarizes where missions stand, what blocks them and which decisions are open. Start here.',
    readOnly: true,
    scopes: ['mission:read'],
    properties: {},
    run(ctx, args) {
      new InputReader(args).finish();
      return { data: briefing(ctx) };
    },
  },
  {
    name: 'recent_activity',
    title: 'Recent activity',
    description:
      "Without missionId, the latest events across missions (type, actor and time, no payloads). With missionId, that mission's event history in order, paged by after and limit.",
    readOnly: true,
    scopes: ['mission:read'],
    properties: {
      missionId: { type: 'string' },
      after: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 200 },
    },
    run(ctx, args) {
      const r = new InputReader(args);
      const missionId = r.optString('missionId', { max: 128, min: 1 });
      const after = r.optInteger('after', { min: 0, max: 2_147_483_647 });
      const limit = r.optInteger('limit', { min: 1, max: 200 }) ?? 50;
      r.finish();
      const { workspaceId } = ctx.caller;
      if (missionId === undefined && after !== undefined) {
        throw new ValidationError([
          { path: 'after', message: 'needs a missionId' },
        ]);
      }
      if (missionId !== undefined) {
        requireMission(ctx, missionId);
        return {
          data: {
            ...ctx.services.core.missions.activity(workspaceId, missionId, {
              afterVersion: after ?? 0,
              limit,
            }),
          },
        };
      }
      const events = ctx.services.db.all<{
        seq: number;
        stream_id: string;
        version: number;
        type: string;
        actor_id: string;
        recorded_at: string;
      }>(
        `SELECT seq, stream_id, version, type, actor_id, recorded_at FROM events
         WHERE workspace_id = ? AND stream_id LIKE 'mission:%'
         ORDER BY seq DESC LIMIT ?`,
        [workspaceId, limit],
      );
      return {
        data: {
          items: events.map((e) => ({
            seq: e.seq,
            missionId: e.stream_id.slice('mission:'.length),
            version: e.version,
            type: e.type,
            actorId: e.actor_id,
            recordedAt: e.recorded_at,
          })),
        },
      };
    },
  },
];
