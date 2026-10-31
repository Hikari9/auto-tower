import { PacketNotFoundError } from '../../core/errors.js';
import { InputReader } from '../../core/validation.js';
import { takeId } from '../args.js';
import type { ToolDefinition } from '../tool.js';
import { requireMission } from './missions.js';

interface ReceiptFacts {
  receipt_id: string;
  packet_id: string;
  attempt_id: string;
  outcome: string;
  self_verification: string;
  independent_review: string;
  reviewer_id: string | null;
  integrated_verification: string;
  failure_class: string | null;
  recorded_at: string;
}

const missionId = { type: 'string' } as const;

export const evidenceTools: readonly ToolDefinition[] = [
  {
    name: 'inspect_evidence',
    title: 'Inspect evidence',
    description:
      "Shows what backs a mission: outcome verification, packet verification, runner claims and the Auto-Office receipt facts. Runner claims and the engine's own check are labelled as self-reported and never count as independent review.",
    readOnly: true,
    scopes: ['mission:read'],
    properties: { missionId, packetId: { type: 'string' } },
    required: ['missionId'],
    run(ctx, args) {
      const { id, rest } = takeId(args, 'missionId');
      const r = new InputReader(rest);
      const only = r.optString('packetId', { max: 128, min: 1 });
      r.finish();
      const mission = requireMission(ctx, id);
      if (only !== undefined && !mission.packets.some((p) => p.id === only)) {
        throw new PacketNotFoundError(only);
      }
      const receipts = ctx.services.db.all<ReceiptFacts>(
        `SELECT receipt_id, packet_id, attempt_id, outcome, self_verification, independent_review,
                reviewer_id, integrated_verification, failure_class, recorded_at
         FROM office_receipts WHERE workspace_id = ? AND mission_id = ? ORDER BY recorded_at, receipt_id`,
        [mission.workspaceId, mission.id],
      );
      const keep = (packetId: string) =>
        only === undefined || packetId === only;
      return {
        data: {
          missionId: mission.id,
          state: mission.state,
          risk: mission.risk,
          outcomeVerification: mission.outcomeVerification,
          evidenceRefs: mission.evidenceRefs,
          packets: mission.packets
            .filter((p) => keep(p.id))
            .map((p) => ({
              id: p.id,
              status: p.status,
              required: p.required,
              verification: p.verification,
            })),
          runnerClaims: mission.attempts
            .filter((a) => a.report !== null && keep(a.packetId))
            .map((a) => ({
              attemptId: a.id,
              packetId: a.packetId,
              runnerId: a.runnerId,
              selfReported: true,
              report: a.report,
            })),
          officeReceipts: receipts
            .filter((row) => keep(row.packet_id))
            .map((row) => ({
              receiptId: row.receipt_id,
              packetId: row.packet_id,
              attemptId: row.attempt_id,
              outcome: row.outcome,
              selfVerification: row.self_verification,
              independentReview: row.independent_review,
              reviewerId: row.reviewer_id,
              integratedVerification: row.integrated_verification,
              failureClass: row.failure_class,
              recordedAt: row.recorded_at,
            })),
          issueLinks: ctx.services.issues.listLinks(
            mission.workspaceId,
            mission.id,
          ),
        },
      };
    },
  },
  {
    name: 'request_reconciliation',
    title: 'Request reconciliation',
    description:
      'Reads every linked issue that holds the mission open back from its provider and records what it finds. It writes nothing to a provider. A reopened or unreadable issue appears as a discrepancy and never as completion.',
    readOnly: false,
    scopes: ['mission:write'],
    properties: { missionId },
    required: ['missionId'],
    async run(ctx, args, key) {
      const { id, rest } = takeId(args, 'missionId');
      new InputReader(rest).finish();
      const report = await ctx.services.issues.verifyMission(
        ctx.command(key),
        id,
      );
      return { data: { report } };
    },
  },
];
