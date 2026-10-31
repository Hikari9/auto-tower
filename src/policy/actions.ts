/**
 * Action names are dotted and lower-case, and the first segments name a category. The category
 * decides what an evaluation requires before it may allow. Callers pick the names, so a runner
 * cannot relabel a sensitive effect by what it claims to be doing.
 */
export const ACTION_PATTERN = /^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)*$/;

export type ActionCategory =
  | 'standard'
  | 'cleanup'
  | 'spend'
  | 'production_deploy'
  | 'security'
  | 'destructive'
  | 'external_issue_close'
  | 'independent_review';

const DESTRUCTIVE_VERBS: readonly string[] = [
  'delete',
  'destroy',
  'drop',
  'purge',
  'wipe',
  'force-push',
];

function under(action: string, prefix: string): boolean {
  return action === prefix || action.startsWith(`${prefix}.`);
}

/**
 * Sensitive words match as the start of any segment, so `deploy.prod-eu`, `db.drop_table` and
 * `billing.spend.create` are caught as well as the plain names. This errs toward asking.
 */
const startsWithAny = (segment: string, words: readonly string[]): boolean =>
  words.some((word) => segment.startsWith(word));

export function categoryOf(action: string): ActionCategory {
  if (under(action, 'cleanup')) {
    return 'cleanup';
  }
  if (under(action, 'review.independent')) {
    return 'independent_review';
  }
  const segments = action.split('.');
  const last = segments[segments.length - 1] ?? '';
  if (segments.some((s) => s.startsWith('spend'))) {
    return 'spend';
  }
  if (
    under(action, 'deploy.prod') ||
    (segments[0] === 'deploy' && startsWithAny(segments[1] ?? '', ['prod']))
  ) {
    return 'production_deploy';
  }
  if (segments.some((s) => s.startsWith('security'))) {
    return 'security';
  }
  if (under(action, 'issue.close')) {
    return 'external_issue_close';
  }
  if (under(action, 'destructive') || startsWithAny(last, DESTRUCTIVE_VERBS)) {
    return 'destructive';
  }
  return 'standard';
}

/**
 * Deny by default even under a broad grant. These need a rule that names the action, the
 * resource and the scope, with no bare wildcard standing in for any of them.
 */
export function isSensitive(category: ActionCategory): boolean {
  return category !== 'standard' && category !== 'cleanup';
}

/** Non-privileged housekeeping that stays allowed when a grant is revoked mid-run. */
export function isSafeCleanup(category: ActionCategory): boolean {
  return category === 'cleanup';
}
