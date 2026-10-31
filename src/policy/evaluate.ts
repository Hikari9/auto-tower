import type { PrincipalKind } from '../auth/principals.js';
import type { Risk } from '../core/types.js';
import {
  type ActionCategory,
  categoryOf,
  isSafeCleanup,
  isSensitive,
} from './actions.js';
import { hasWildcard, matchesPattern } from './patterns.js';
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

/** Everything about a rule that is not its own lifecycle: who, what, where, which mission. */
function covers(
  rule: PolicyRule,
  input: EvaluationInput,
  principal: { id: string; kind: PrincipalKind },
): boolean {
  const { grantee, limits } = rule;
  return (
    (grantee.kind === null || grantee.kind === principal.kind) &&
    (grantee.principalId === null || grantee.principalId === principal.id) &&
    matchesPattern(rule.action, input.action) &&
    matchesPattern(rule.resource, input.resource) &&
    matchesPattern(rule.scope, input.scope) &&
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
  if (input.amount === undefined) {
    return true;
  }
  // A grant with no cap says nothing about how much may be spent, so it covers no amount.
  return (
    rule.limits.maxAmount !== null && input.amount <= rule.limits.maxAmount
  );
}

/** A sensitive action needs a rule that names it, its resource and its scope. */
function isExplicit(rule: PolicyRule): boolean {
  return (
    !hasWildcard(rule.action) && rule.resource !== '*' && rule.scope !== '*'
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
      covers(rule, input, principal),
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

  const allows = input.rules.filter(
    (rule) => rule.effect === 'allow' && covers(rule, input, principal),
  );
  const live = allows.filter(
    (rule) => activeAt(rule, input.now) && coversEffort(rule, input),
  );
  const named = live.filter(isExplicit);
  const grant = isSensitive(category) ? named[0] : live[0];
  if (grant !== undefined) {
    return result('allow', 'granted', `allowed by rule ${grant.id}`, grant);
  }

  if (isSafeCleanup(category)) {
    return result(
      'allow',
      'safe_cleanup',
      'non-privileged cleanup is always allowed',
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
