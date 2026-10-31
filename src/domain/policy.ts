import { RISK_ORDER } from './types.ts';
import type { AuthorityEnvelope, Grantee, PolicyEvaluation, PolicyRequest, PolicyRule, Risk } from './types.ts';

/**
 * Actions under these prefixes are sensitive: spend, production deploys, security
 * controls, destructive operations and policy itself. They stay denied unless a
 * human explicitly put them in a mission envelope or granted a scoped rule.
 */
export const SENSITIVE_PREFIXES = ['spend', 'deploy.prod', 'security', 'destructive', 'policy', 'secrets'] as const;

export function isSensitive(action: string): boolean {
  return SENSITIVE_PREFIXES.some((p) => action === p || action.startsWith(`${p}.`) || action.startsWith(`${p}:`));
}

/** Glob match where `*` matches any run of characters. Everything else is literal. */
export function matchPattern(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  const re = new RegExp(`^${pattern.split('*').map(escapeRe).join('.*')}$`);
  return re.test(value);
}

const escapeRe = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

export function envelopeCovers(env: AuthorityEnvelope, action: string, resource: string): boolean {
  return env.actions.some((a) => matchPattern(a, action)) && env.resources.some((r) => matchPattern(r, resource));
}

/** True when a pattern's literal prefix already names a sensitive action ("deploy.prod", "spend.*"). */
export function namesSensitive(pattern: string): boolean {
  return isSensitive(pattern.split('*')[0]!.replace(/[.:]$/, ''));
}

/** True when a pattern could match some sensitive action ("*", "deploy.*", "spe*"). */
export function mayMatchSensitive(pattern: string): boolean {
  return SENSITIVE_PREFIXES.some((p) => matchPattern(pattern, p) || matchPattern(pattern, `${p}.x`) || matchPattern(pattern, `${p}:x`) || isSensitive(pattern.split('*')[0]!));
}

/**
 * Envelope authorization. A sensitive action is covered only by an envelope entry
 * that names it explicitly; a wildcard such as "*" or "deploy.*" never reaches it.
 */
export function envelopeAuthorizes(env: AuthorityEnvelope, action: string, resource: string): boolean {
  const sensitive = isSensitive(action);
  return env.actions.some((a) => matchPattern(a, action) && (!sensitive || namesSensitive(a))) && env.resources.some((r) => matchPattern(r, resource));
}

/** True when `inner` adds no action or resource beyond `outer`. */
export function envelopeWithin(inner: AuthorityEnvelope, outer: AuthorityEnvelope): boolean {
  return (
    inner.actions.every((a) => outer.actions.some((o) => matchPattern(o, a))) &&
    inner.resources.every((r) => outer.resources.some((o) => matchPattern(o, r)))
  );
}

function granteeMatches(rule: Grantee, req: Grantee): boolean {
  return rule === 'any' || rule === req;
}

export function ruleLive(rule: PolicyRule, now: string): boolean {
  if (rule.status !== 'active') return false;
  if (rule.expiresAt && rule.expiresAt <= now) return false;
  if (rule.conditions.maxUses !== undefined && rule.uses >= rule.conditions.maxUses) return false;
  return true;
}

function ruleCovers(rule: PolicyRule, req: PolicyRequest): boolean {
  if (!granteeMatches(rule.grantee, req.grantee)) return false;
  if (!matchPattern(rule.action, req.action) || !matchPattern(rule.resource, req.resource)) return false;
  if (rule.effect === 'allow') {
    const max: Risk | undefined = rule.conditions.maxRisk;
    if (max && RISK_ORDER[req.risk] > RISK_ORDER[max]) return false;
    if (rule.conditions.missionIds?.length && (!req.missionId || !rule.conditions.missionIds.includes(req.missionId))) return false;
  }
  return true;
}

export interface EvaluationContext {
  rules: PolicyRule[];
  policyVersion: number;
  now: string;
  halted: boolean;
  /** Mission envelope (tier 1). Only applies when the request risk is within the mission risk. */
  envelope?: { authority: AuthorityEnvelope; risk: Risk };
}

/**
 * Default-deny evaluation. Order: emergency halt, explicit deny, mission envelope,
 * explicit allow rule. Preferences are not an input: learned signals cannot grant.
 */
export function evaluatePolicy(req: PolicyRequest, ctx: EvaluationContext): PolicyEvaluation {
  const base = { policyVersion: ctx.policyVersion };
  if (ctx.halted) return { ...base, allowed: false, basis: 'halted', reason: 'workspace is under emergency halt' };

  const live = ctx.rules.filter((r) => ruleLive(r, ctx.now));
  const deny = live.find((r) => r.effect === 'deny' && ruleCovers(r, req));
  if (deny) return { ...base, allowed: false, basis: 'deny_rule', ruleId: deny.id, reason: `denied by rule ${deny.id}` };

  if (ctx.envelope && RISK_ORDER[req.risk] <= RISK_ORDER[ctx.envelope.risk] && envelopeAuthorizes(ctx.envelope.authority, req.action, req.resource)) {
    return { ...base, allowed: true, basis: 'envelope', reason: 'within the mission authority envelope' };
  }

  const allow = live.find((r) => r.effect === 'allow' && ruleCovers(r, req));
  if (allow) return { ...base, allowed: true, basis: 'rule', ruleId: allow.id, reason: `allowed by rule ${allow.id}` };

  if (isSensitive(req.action)) {
    return { ...base, allowed: false, basis: 'sensitive_default_deny', reason: `${req.action} is sensitive and has no explicit grant` };
  }
  return { ...base, allowed: false, basis: 'default_deny', reason: `no grant covers ${req.action} on ${req.resource}` };
}

/** Pattern key used to group similar human approvals into a standing-rule proposal. */
export function approvalPatternKey(action: string, resource: string): string {
  return `${action}|${resource}`;
}
