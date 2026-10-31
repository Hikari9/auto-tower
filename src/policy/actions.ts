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
  'truncate',
  'remove',
];

function under(action: string, prefix: string): boolean {
  return action === prefix || action.startsWith(`${prefix}.`);
}

const startsWithAny = (segment: string, words: readonly string[]): boolean =>
  words.some((word) => segment.startsWith(word));

/**
 * The category of every part of the name but a leading `cleanup`. A name is read as words split on
 * `.`, `-` and `_`. A sensitive word counts when a word starts with it, wherever it sits, so
 * `deploy.prod-eu`, `deploy.to-prod`, `db.table_drop`, `git.push_force`, `billing.spend.create`
 * and `cleanup.issue.close` are all caught. This errs toward asking.
 */
function sensitiveCategory(action: string): ActionCategory {
  const words = action.split(/[._-]/);
  const any = (starts: readonly string[]) =>
    words.some((w) => startsWithAny(w, starts));
  const followed = (first: string, second: string) =>
    words.some((w, i) => w === first && words[i + 1]?.startsWith(second));
  if (followed('review', 'independent')) {
    return 'independent_review';
  }
  if (any(['spend'])) {
    return 'spend';
  }
  if (any(['deploy', 'release', 'ship', 'publish']) && any(['prod'])) {
    return 'production_deploy';
  }
  if (any(['security'])) {
    return 'security';
  }
  if (followed('issue', 'close')) {
    return 'external_issue_close';
  }
  if (
    any(['destructive']) ||
    any(DESTRUCTIVE_VERBS) ||
    (any(['force']) && any(['push']))
  ) {
    return 'destructive';
  }
  return 'standard';
}

/**
 * A `cleanup.*` name is safe cleanup only when nothing else in the name is sensitive, so a
 * caller cannot present `cleanup.drop-prod-db` or `cleanup.spend.refund` as housekeeping.
 */
export function categoryOf(action: string): ActionCategory {
  const category = sensitiveCategory(action);
  return category === 'standard' && under(action, 'cleanup')
    ? 'cleanup'
    : category;
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
