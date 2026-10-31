import type { PrincipalKind } from '../auth/principals.js';
import type { Risk } from '../core/types.js';
import {
  type ActionCategory,
  categoryOf,
  isSafeCleanup,
  isSensitive,
} from './actions.js';
import { hasWildcard, matchesPattern, patternsOverlap } from './patterns.js';
import type {
  EvaluationCode,
  EvaluationEffect,
  PolicyEvaluation,
  PolicyRule,
} from './types.js';

const RISK_RANK: Readonly<Record<Risk, number>> = {
  low: 0,
  medium: 1,
  high: 2,
};

export const riskAtMost = (risk: Risk, ceiling: Risk): boolean =>
  RISK_RANK[risk] <= RISK_RANK[ceiling];

export interface EvaluationInput {
  rules: readonly PolicyRule[];
  policyVersion: number;
  now: Date;
  principal: { id: string; kind: PrincipalKind } | undefined;
  principalDisabled: boolean;
  action: string;
  resource: string;
  scope: string;
  risk: Risk;
  amount: number | undefined;
  missionId: string | undefined;
  /** Principals that produced the work, for independent review. */
  producers: ReadonlySet<string>;
  /** True when the principal holds the live lease of the attempt the request names. */
  holdsLease: boolean;
  /** Count only this allow rule. Used to check a rule someone cites, so another rule cannot stand in for it. */
  onlyRuleId?: string | undefined;
  /** Report `escalate` instead of `deny` when nothing covers the request and nothing forbids it. */
  escalate: boolean;
}

export function policyRefFor(
  policyVersion: number,
  rule: { id: string; version: number } | null,
  tail: string,
): string {
  return rule === null
    ? `policy:v${policyVersion}:${tail}`
    : `policy:v${policyVersion}:rule:${rule.id}@${rule.version}`;
}

function activeAt(rule: PolicyRule, now: Date): boolean {
  return (
    rule.revokedAt === null &&
    (rule.expiresAt === null || Date.parse(rule.expiresAt) > now.getTime())
  );
}

/**
 * Everything about a rule that is not its own lifecycle: who, what, where, which mission. With
 * `overlap`, the request's action, resource and scope are patterns, and the rule counts when it
 * reaches any member of them. A deny rule uses that in citing mode, so a narrow deny (`a.b`) still
 * stops a request for a broader pattern (`a.*`).
 */
function covers(
  rule: PolicyRule,
  input: EvaluationInput,
  principal: { id: string; kind: PrincipalKind },
  overlap = false,
): boolean {
  const { grantee, limits } = rule;
  const reaches = overlap ? patternsOverlap : matchesPattern;
  return (
    (grantee.kind === null || grantee.kind === principal.kind) &&
    (grantee.principalId === null || grantee.principalId === principal.id) &&
    reaches(rule.action, input.action) &&
    reaches(rule.resource, input.resource) &&
    reaches(rule.scope, input.scope) &&
    (limits.missionIds === null ||
      (input.missionId !== undefined &&
        limits.missionIds.includes(input.missionId)))
  );
}

/** An allow rule also has to cover the request's risk and amount. */
function coversEffort(rule: PolicyRule, input: EvaluationInput): boolean {
  if (!riskAtMost(input.risk, rule.maxRisk)) {
    return false;
  }
  const { maxAmount } = rule.limits;
  if (input.amount === undefined) {
    // A cap only means something against a stated amount.
    return maxAmount === null;
  }
  // A grant with no cap says nothing about how much may be spent, so it covers no amount.
  return maxAmount !== null && input.amount <= maxAmount;
}

/** A name that is only wildcards is a wildcard, however many `*` it has. */
const isBareWildcard = (pattern: string): boolean => /^\*+$/.test(pattern);

/** A sensitive action needs a rule that names it, its resource and its scope. */
function isExplicit(rule: PolicyRule): boolean {
  return (
    !hasWildcard(rule.action) &&
    !isBareWildcard(rule.resource) &&
    !isBareWildcard(rule.scope)
  );
}

/**
 * Decides one request against the rules as they stand. Default deny: nothing is allowed unless an
 * active allow rule covers it, and an active deny rule beats every allow. Preferences,
 * proposals and confidence are not inputs, so they cannot change the outcome.
 */
export function evaluate(input: EvaluationInput): PolicyEvaluation {
  const evaluatedAt = input.now.toISOString();
  const version = input.policyVersion;
  const result = (
    effect: EvaluationEffect,
    code: EvaluationCode,
    reason: string,
    rule: PolicyRule | null = null,
    tail = code,
  ): PolicyEvaluation => ({
    effect,
    code,
    reason,
    ruleId: rule?.id ?? null,
    ruleVersion: rule?.version ?? null,
    policyVersion: version,
    policyRef: policyRefFor(version, rule, tail),
    evaluatedAt,
  });

  const { principal } = input;
  if (principal === undefined) {
    return result(
      'deny',
      'unknown_principal',
      'the principal is not in this workspace',
    );
  }
  if (input.principalDisabled) {
    return result('deny', 'principal_disabled', 'the principal is disabled');
  }
  const category: ActionCategory = categoryOf(input.action);

  const denied = input.rules.find(
    (rule) =>
      rule.effect === 'deny' &&
      activeAt(rule, input.now) &&
      covers(rule, input, principal, input.onlyRuleId !== undefined),
  );
  if (denied !== undefined) {
    return result(
      'deny',
      'explicit_deny',
      `denied by rule ${denied.id}`,
      denied,
    );
  }

  // Permission to act is a separate gate from independent review. No grant lets the
  // producer of the work, or anyone acting for it, satisfy a required review.
  if (category === 'independent_review' && input.producers.has(principal.id)) {
    return result(
      'deny',
      'producer_cannot_review',
      'a producer of this work cannot satisfy an independent review',
    );
  }

  // Spending without saying how much would slip past every cap.
  if (category === 'spend' && input.amount === undefined) {
    return result(
      'deny',
      'amount_required',
      'a spend request must state its amount',
    );
  }

  const allows = input.rules.filter(
    (rule) =>
      rule.effect === 'allow' &&
      (input.onlyRuleId === undefined || rule.id === input.onlyRuleId) &&
      covers(rule, input, principal),
  );
  const live = allows.filter(
    (rule) => activeAt(rule, input.now) && coversEffort(rule, input),
  );
  const named = live.filter(isExplicit);
  const grant = isSensitive(category) ? named[0] : live[0];
  if (grant !== undefined) {
    return result('allow', 'granted', `allowed by rule ${grant.id}`, grant);
  }

  if (
    isSafeCleanup(
      category,
      input.resource,
      principal.kind === 'human' || input.holdsLease,
    )
  ) {
    return result(
      'allow',
      'safe_cleanup',
      'non-privileged cleanup is allowed to a person or the attempt that holds the lease',
    );
  }
  const ranOut = [...allows]
    .filter((rule) => !activeAt(rule, input.now) && coversEffort(rule, input))
    .sort((a, b) => b.createdSeq - a.createdSeq)[0];
  if (ranOut !== undefined) {
    const revoked = ranOut.revokedAt !== null;
    return result(
      input.escalate ? 'escalate' : 'deny',
      revoked ? 'grant_revoked' : 'grant_expired',
      `rule ${ranOut.id} is ${revoked ? 'revoked' : 'expired'}`,
      ranOut,
    );
  }
  if (live.length > 0) {
    return result(
      input.escalate ? 'escalate' : 'deny',
      'sensitive_requires_explicit_grant',
      `${category} actions need a grant that names the action, resource and scope`,
    );
  }
  return result(
    input.escalate ? 'escalate' : 'deny',
    'no_matching_grant',
    'no active grant covers this request',
  );
}
