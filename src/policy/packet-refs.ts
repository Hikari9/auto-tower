import type { MissionState, WorkPacket } from '../core/types.js';
import { hasTraversal } from './patterns.js';
import type { PolicyService } from './service.js';

const RULE_REF = /^policy:v\d+:rule:([^@\s]+)@(\d+)$/;

export interface PacketAuthority {
  workspaceId: string;
  actor: { id: string };
  mission: Pick<MissionState, 'id' | 'risk'>;
  packet: Pick<WorkPacket, 'id' | 'scope'>;
}

/**
 * Resolves each policy ref a Chief of Staff cites for authorizing a packet and evaluates it again
 * now, at the point of effect. A ref is only a name: it counts when it names a rule that exists at
 * the version cited, and that rule still allows this actor at the mission's risk, on the mission,
 * for every scope the packet declares, with no deny rule in the way. Returns why the first ref
 * fails, or `undefined` when all of them hold. Nothing is recorded, so a refusal that rolls back
 * the caller's transaction leaves no trace behind.
 */
export function refusalForPolicyRefs(
  policy: Pick<PolicyService, 'getRule' | 'authorize'>,
  authority: PacketAuthority,
  policyRefs: readonly string[],
): string | undefined {
  const { workspaceId, actor, mission, packet } = authority;
  // Other refs, such as the decision an answer resumes, are links for the audit trail. They carry
  // no authority, so they are neither checked nor counted as the policy cited.
  const cited = policyRefs.filter((ref) => ref.startsWith('policy:'));
  if (cited.length === 0) {
    return 'a chief of staff must cite the policy rule it acts under';
  }
  if (packet.scope.length === 0 || packet.scope.some(hasTraversal)) {
    return `packet ${packet.id} declares no scope a rule can be checked against`;
  }
  for (const ref of cited) {
    const match = RULE_REF.exec(ref);
    const rule =
      match === null ? undefined : policy.getRule(workspaceId, match[1] ?? '');
    if (rule === undefined || rule.version !== Number(match?.[2])) {
      return `policy ref ${ref} does not name a current rule`;
    }
    if (rule.effect !== 'allow') {
      return `policy ref ${ref} names a deny rule`;
    }
    for (const scope of packet.scope) {
      const evaluation = policy.authorize(
        {
          workspace: workspaceId,
          principal: actor.id,
          action: rule.action,
          resource: rule.resource,
          scope,
          risk: mission.risk,
          // A capped rule is checked at its own ceiling, so only its other limits can fail here.
          amount: rule.limits.maxAmount ?? undefined,
          missionId: mission.id,
        },
        { citing: rule.id },
      );
      if (evaluation.effect !== 'allow' || evaluation.code !== 'granted') {
        return `policy ref ${ref} does not cover scope ${scope}: ${evaluation.reason}`;
      }
    }
  }
  return undefined;
}
