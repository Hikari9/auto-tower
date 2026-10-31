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

export function categoryOf(action: string): ActionCategory {
  if (under(action, 'cleanup')) {
    return 'cleanup';
  }
  if (under(action, 'review.independent')) {
    return 'independent_review';
  }
  if (under(action, 'spend')) {
    return 'spend';
  }
  if (under(action, 'deploy.production') || under(action, 'deploy.prod')) {
    return 'production_deploy';
  }
  if (under(action, 'security')) {
    return 'security';
  }
  if (under(action, 'issue.close')) {
    return 'external_issue_close';
  }
  const last = action.slice(action.lastIndexOf('.') + 1);
  if (under(action, 'destructive') || DESTRUCTIVE_VERBS.includes(last)) {
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
