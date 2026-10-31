/**
 * Action names are dotted and lower-case. Which names are sensitive is decided by the registry
 * below and by nothing else, so a caller cannot relabel a sensitive effect by what it claims to be
 * doing, and no spelling trick reads a registered effect as ordinary. Callers pick the names.
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

type Sensitive = Exclude<ActionCategory, 'standard' | 'cleanup'>;

/**
 * The registry. Each entry is a run of whole dot-separated segments, and an action belongs to the
 * category when its segments contain that run anywhere: `deploy.live` is registered, so is
 * `ops.deploy.live.eu`, while `deployments.live` is not. Segments are compared whole. They are
 * never split further or matched by prefix. An unregistered name is `standard`, so a new kind of
 * sensitive effect must be added here before anything may rely on it being refused by default.
 * The first category with a match wins, in the order listed.
 */
const REGISTRY: ReadonlyArray<readonly [Sensitive, readonly string[]]> = [
  ['independent_review', ['review.independent']],
  [
    'spend',
    [
      'spend',
      'billing',
      'payment',
      'payments',
      'purchase',
      'invoice.pay',
      'subscription.upgrade',
    ],
  ],
  [
    'production_deploy',
    [
      'deploy.prod',
      'deploy.production',
      'deploy.live',
      'deploy.release',
      'release.prod',
      'release.production',
      'release.live',
      'release.publish',
      'publish.prod',
      'publish.production',
      'publish.live',
      'promote.prod',
      'promote.production',
    ],
  ],
  [
    'security',
    [
      'security',
      'secret',
      'secrets',
      'iam',
      'firewall',
      'credential',
      'credentials',
      'permission.grant',
      'token.issue',
    ],
  ],
  [
    'external_issue_close',
    ['issue.close', 'issue.resolve', 'ticket.close', 'ticket.resolve'],
  ],
  [
    'destructive',
    [
      'destructive',
      'delete',
      'destroy',
      'drop',
      'purge',
      'wipe',
      'truncate',
      'remove',
      'force-push',
      'push-force',
      'force_push',
      'push_force',
      'push.force',
      'force.push',
    ],
  ],
];

function hasRun(segments: readonly string[], run: readonly string[]): boolean {
  for (let at = 0; at + run.length <= segments.length; at++) {
    if (run.every((part, i) => segments[at + i] === part)) {
      return true;
    }
  }
  return false;
}

const REGISTERED = REGISTRY.map(
  ([category, names]) =>
    [category, names.map((name) => name.split('.'))] as const,
);

/** The registered sensitive category of a name, ignoring any `cleanup` prefix, or `undefined`. */
function registeredCategory(action: string): Sensitive | undefined {
  const segments = action.split('.');
  return REGISTERED.find(([, runs]) =>
    runs.some((run) => hasRun(segments, run)),
  )?.[0];
}

/**
 * A `cleanup.*` name is cleanup only when no part of it is registered as sensitive, so a caller
 * cannot present `cleanup.issue.close` or `cleanup.billing.refund` as housekeeping.
 */
export function categoryOf(action: string): ActionCategory {
  const sensitive = registeredCategory(action);
  if (sensitive !== undefined) {
    return sensitive;
  }
  return action === 'cleanup' || action.startsWith('cleanup.')
    ? 'cleanup'
    : 'standard';
}

/**
 * Deny by default even under a broad grant. These need a rule that names the action, the
 * resource and the scope, with no bare wildcard standing in for any of them.
 */
export function isSensitive(category: ActionCategory): boolean {
  return category !== 'standard' && category !== 'cleanup';
}

/** Cleanup of one of these is never allowed without a grant, whoever asks. */
const DESTRUCTIVE_RESOURCES: ReadonlySet<string> = new Set([
  'db',
  'database',
  'prod',
  'production',
  'backup',
  'backups',
  'secret',
  'secrets',
  'volume',
  'bucket',
  'disk',
]);

/**
 * True when a resource is one a grantless cleanup must not touch: it has a registered segment
 * (`db:orders`, `env:prod`, `repo:app/backups`), or it is a bare wildcard that could be any of them.
 */
export function isDestructiveResource(resource: string): boolean {
  return (
    /^\*+$/.test(resource) ||
    resource
      .split(/[:/.]/)
      .some((segment) => DESTRUCTIVE_RESOURCES.has(segment.toLowerCase()))
  );
}

/**
 * Non-privileged housekeeping that stays allowed when a grant is revoked mid-run. It is allowed
 * without a grant only to a human or to the principal holding the attempt's live lease, and never
 * for a destructive resource. Anyone else needs a grant like any other action.
 */
export function isSafeCleanup(
  category: ActionCategory,
  resource: string,
  allowedWithoutGrant: boolean,
): boolean {
  return (
    category === 'cleanup' &&
    allowedWithoutGrant &&
    !isDestructiveResource(resource)
  );
}
