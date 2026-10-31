import { fail } from '../domain/errors.ts';
import type { Actor, PrincipalKind } from '../domain/types.ts';

export const SCOPES = [
  'missions:read',
  'missions:write',
  'decisions:read',
  'decisions:answer',
  'decisions:answer:chief',
  'policy:read',
  'policy:propose',
  'policy:grant',
  'runners:read',
  'runners:admin',
  'runner:protocol',
  'evidence:read',
  'admin',
] as const;
export type Scope = (typeof SCOPES)[number];

/** Default scopes per principal kind. Hard kind checks below still apply on top. */
export const DEFAULT_SCOPES: Record<PrincipalKind, Scope[]> = {
  human: SCOPES.filter((s) => s !== 'runner:protocol' && s !== 'decisions:answer:chief'),
  chief: ['missions:read', 'missions:write', 'decisions:read', 'decisions:answer:chief', 'policy:read', 'policy:propose', 'runners:read', 'evidence:read'],
  runner: ['runner:protocol'],
  provider: [],
  system: [],
};

/** Scopes that only a human principal may ever hold, whatever a token claims. */
const HUMAN_ONLY: Scope[] = ['policy:grant', 'decisions:answer', 'runners:admin', 'admin'];

export function sanitizeScopes(kind: PrincipalKind, requested: string[] | undefined): Scope[] {
  const base = requested?.length ? requested : DEFAULT_SCOPES[kind];
  const valid = base.filter((s): s is Scope => (SCOPES as readonly string[]).includes(s));
  return kind === 'human' ? valid : valid.filter((s) => !HUMAN_ONLY.includes(s) && (kind === 'runner' ? s === 'runner:protocol' : s !== 'runner:protocol'));
}

export function requireScope(actor: Actor, scope: Scope): void {
  const p = actor.principal;
  if (p.status !== 'active') fail('unauthenticated', 'principal is revoked');
  if (HUMAN_ONLY.includes(scope) && p.kind !== 'human') fail('forbidden', `${scope} requires a human principal`);
  if (!p.scopes.includes(scope)) fail('forbidden', `missing scope ${scope}`);
}

export function requireKind(actor: Actor, ...kinds: PrincipalKind[]): void {
  if (!kinds.includes(actor.principal.kind)) fail('forbidden', `requires a ${kinds.join(' or ')} principal`);
}
