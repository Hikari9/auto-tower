import { createHash } from 'node:crypto';
import { MissionNotFoundError, PacketNotFoundError } from '../core/errors.js';
import type { CompletionGuardRegistry } from '../core/guards.js';
import { loadMission } from '../core/projection.js';
import { createMissionService } from '../core/service.js';
import type { Actor, MissionState } from '../core/types.js';
import { categoryOf, isSensitive } from '../policy/actions.js';
import { riskAtMost } from '../policy/evaluate.js';
import { createPolicyService } from '../policy/service.js';
import { joinTransaction } from '../policy/transaction.js';
import type {
  AuthorizeRequest,
  EvaluationCode,
  PolicyEvaluation,
} from '../policy/types.js';
import { newId } from '../shared/ids.js';
import type { SqlDatabase } from '../storage/database.js';
import { packetCovers, withinAuthorizedScope } from './binding.js';
import { createDecisionInbox } from './inbox.js';
import type { ExpansionInput } from './inputs.js';
import type { Decision, DecisionCategory } from './types.js';

export interface ExpansionRequest extends ExpansionInput {
  workspaceId: string;
  /** The principal asking. A runner or provider can ask. It can never be the one that approves. */
  requester: Actor;
  correlationId?: string | undefined;
}

/**
 * The tier a request was settled at, following the three tiers of the spec:
 * 1 in approved scope, 2 a Chief of Staff under a delegated rule, 3 a person.
 * `denied` is a standing deny rule: nobody can approve past it.
 */
export type ExpansionOutcome =
  | { tier: 1; outcome: 'proceed' }
  | {
      tier: 2;
      outcome: 'approved';
      evaluation: PolicyEvaluation;
      mission: MissionState;
    }
  | {
      tier: 2 | 3;
      outcome: 'decision_required';
      decision: Decision;
      created: boolean;
      evaluation: PolicyEvaluation;
    }
  | { tier: 'denied'; outcome: 'denied'; evaluation: PolicyEvaluation };

export interface ExpansionRouterDeps {
  db: SqlDatabase;
  guards: CompletionGuardRegistry;
  clock?: () => Date;
  newId?: (prefix: string) => string;
}

/** Evaluations that a person or delegate cannot override by approving. */
const FINAL: readonly EvaluationCode[] = [
  'explicit_deny',
  'unknown_principal',
  'principal_disabled',
  'producer_cannot_review',
];

const LIVE_MISSION: readonly string[] = [
  'draft',
  'planning',
  'ready',
  'running',
  'waiting-runner',
  'waiting-decision',
  'waiting-external',
  'needs-attention',
];

const CATEGORY_BY_ACTION: Readonly<
  Record<ReturnType<typeof categoryOf>, DecisionCategory>
> = {
  standard: 'scope_expansion',
  cleanup: 'scope_expansion',
  spend: 'spend',
  production_deploy: 'production',
  security: 'security',
  destructive: 'destructive',
  external_issue_close: 'sensitive_action',
  independent_review: 'sensitive_action',
};

function defaultDedupeKey(request: ExpansionRequest): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        request.action,
        request.resource,
        request.scope,
        request.risk,
        request.amount,
      ]),
    )
    .digest('hex');
  return `expansion:${digest.slice(0, 40)}`;
}

/**
 * Tier 1: follow-up inside what the mission already authorized. The request has to stay inside the
 * scope of authorized sibling packets, at no more than the mission's risk, and carry nothing
 * sensitive or any amount. The target packet's own declared scope has to stay inside it too, so a
 * packet cannot vouch for itself and a requester's claim is checked against mission data.
 */
function inApprovedScope(
  mission: MissionState,
  request: ExpansionRequest,
): boolean {
  if (
    isSensitive(categoryOf(request.action)) ||
    categoryOf(request.action) === 'cleanup' ||
    request.amount !== null ||
    !LIVE_MISSION.includes(mission.state) ||
    !riskAtMost(request.risk, mission.risk)
  ) {
    return false;
  }
  const packet = mission.packets.find((p) => p.id === request.packetId);
  return withinAuthorizedScope(packet, mission.packets, request.scope);
}

export function createExpansionRouter(
  deps: ExpansionRouterDeps,
): (request: ExpansionRequest) => ExpansionOutcome {
  const ids = deps.newId ?? newId;

  return (request) =>
    deps.db.transaction((raw) => {
      const tx = joinTransaction(raw);
      const policy = createPolicyService({
        db: tx,
        ...(deps.clock === undefined ? {} : { clock: deps.clock }),
        newId: ids,
      });
      const inbox = createDecisionInbox({
        db: tx,
        guards: deps.guards,
        ...(deps.clock === undefined ? {} : { clock: deps.clock }),
        newId: ids,
      });
      const ctx = {
        workspaceId: request.workspaceId,
        actor: request.requester,
        correlationId: request.correlationId ?? ids('cor'),
      };
      const mission = loadMission(tx, request.workspaceId, request.missionId);
      if (mission === undefined) {
        throw new MissionNotFoundError(request.missionId);
      }
      // Only a null packet id is a mission-level request. An id that names nothing is an error.
      if (
        request.packetId !== null &&
        !mission.packets.some((p) => p.id === request.packetId)
      ) {
        throw new PacketNotFoundError(request.packetId);
      }
      const evaluationRequest: AuthorizeRequest = {
        workspace: request.workspaceId,
        principal: request.requester.id,
        action: request.action,
        resource: request.resource,
        scope: request.scope,
        risk: request.risk,
        amount: request.amount ?? undefined,
        missionId: request.missionId,
      };

      const own = policy.authorize(evaluationRequest);
      if (own.effect === 'deny' && FINAL.includes(own.code)) {
        policy.record(evaluationRequest, own);
        return { tier: 'denied', outcome: 'denied', evaluation: own };
      }

      if (inApprovedScope(mission, request)) {
        return { tier: 1, outcome: 'proceed' };
      }

      // Tier 2, asked of the Chief of Staff. Only a Chief of Staff can approve, and only under a
      // current rule that covers this request. Its own confidence is shown, never evaluated.
      if (request.requester.kind === 'chief_of_staff') {
        const evaluation = policy.authorize(evaluationRequest, {
          escalate: true,
        });
        const packet = mission.packets.find((p) => p.id === request.packetId);
        // Only a rule can approve. Safe cleanup is allowed without one and is not an approval.
        // The request must also lie inside what the packet declares it will touch.
        if (
          evaluation.effect === 'allow' &&
          evaluation.code === 'granted' &&
          (packet === undefined || packetCovers(packet, request.scope))
        ) {
          if (packet === undefined) {
            return {
              tier: 2,
              outcome: 'approved',
              evaluation,
              mission,
            };
          }
          const result = createMissionService({
            db: tx,
            guards: deps.guards,
          }).authorizePacket(
            ctx,
            request.missionId,
            mission.version,
            packet.id,
            [evaluation.policyRef],
          );
          return {
            tier: 2,
            outcome: 'approved',
            evaluation,
            mission: result.mission,
          };
        }
      }

      // Nobody who may approve is on hand, so this one branch waits on a durable decision. The
      // decision is raised for a Chief of Staff when a delegated rule would let one answer it,
      // and for a person otherwise.
      const delegation =
        request.requester.kind === 'chief_of_staff'
          ? undefined
          : policy.authorizeDelegate(evaluationRequest);
      const target = mission.packets.find((p) => p.id === request.packetId);
      const delegated =
        delegation?.effect === 'allow' &&
        delegation.code === 'granted' &&
        (target === undefined || packetCovers(target, request.scope));
      const evaluation = policy.authorize(evaluationRequest, {
        escalate: true,
      });
      const created = inbox.raise(ctx, {
        dedupeKey: request.dedupeKey ?? defaultDedupeKey(request),
        category:
          request.category ?? CATEGORY_BY_ACTION[categoryOf(request.action)],
        urgency: request.urgency,
        question: request.question,
        alternatives: request.alternatives,
        recommendation: request.recommendation,
        consequences: request.consequences,
        requiredAuthority: delegated ? 'chief_of_staff' : 'human',
        evidence: request.evidence,
        affectedScope:
          request.affectedScope.length > 0
            ? request.affectedScope
            : [request.scope],
        request: {
          action: request.action,
          resource: request.resource,
          scope: request.scope,
          risk: request.risk,
          amount: request.amount,
        },
        advisory: request.advisory,
        branches: [
          { missionId: request.missionId, packetId: request.packetId },
        ],
      });
      // Recorded once the request proved valid, so a rejected one leaves nothing behind.
      policy.record(evaluationRequest, evaluation);
      return {
        tier: created.decision.requiredAuthority === 'human' ? 3 : 2,
        outcome: 'decision_required',
        decision: created.decision,
        created: created.created,
        evaluation,
      };
    });
}
