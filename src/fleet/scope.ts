import type { WorkPacket } from '../core/types.js';

/**
 * A packet's `scope` is a list of opaque strings. The fleet reads three conventions from it:
 * `cap:<name>` entries are capabilities a runner must declare, `repo:<name>` and
 * `worktree:<name>` entries name the mutable execution scope, and every other entry
 * (`cap:` excluded) is a scope the runner must be allowed to touch.
 */
export interface PacketRequirements {
  capabilities: string[];
  /** Everything the runner must be allowed: all non-capability entries. */
  scopes: string[];
  scopeKey: string;
  /**
   * Why no single execution scope can be derived, or undefined. A packet that names two repos,
   * two worktrees, a worktree without a repo or a malformed name would otherwise lock only part of
   * what it touches, so it is never dispatched.
   */
  invalid: string | undefined;
}

const NAME = /^[a-z0-9][a-z0-9._/-]{0,127}$/;

/** `Repo`, `repo/` and `repo.git` are one repository. */
function normalise(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
}

export function requirementsOf(
  missionId: string,
  packet: Pick<WorkPacket, 'id' | 'scope'>,
): PacketRequirements {
  const capabilities: string[] = [];
  const scopes: string[] = [];
  const repos: string[] = [];
  const worktrees: string[] = [];
  for (const entry of packet.scope) {
    if (entry.startsWith('cap:')) {
      capabilities.push(entry.slice(4));
      continue;
    }
    scopes.push(entry);
    if (entry.startsWith('repo:')) {
      repos.push(normalise(entry.slice(5)));
    } else if (entry.startsWith('worktree:')) {
      worktrees.push(normalise(entry.slice(9)));
    }
  }
  const alone = `packet:${missionId}/${packet.id}`;
  let invalid: string | undefined;
  if (repos.length > 1) {
    invalid = 'it names more than one repo';
  } else if (worktrees.length > 1) {
    invalid = 'it names more than one worktree';
  } else if (worktrees.length === 1 && repos.length === 0) {
    invalid = 'it names a worktree but no repo';
  } else if ([...repos, ...worktrees].some((name) => !NAME.test(name))) {
    invalid = 'a repo or worktree name is not a plain name';
  }
  const repo = repos[0];
  // Without a declared repo nothing is shared, so the packet only excludes itself.
  const scopeKey =
    repo === undefined || invalid !== undefined
      ? alone
      : `repo:${repo}#worktree:${worktrees[0] ?? 'default'}`;
  return { capabilities, scopes, scopeKey, invalid };
}

/** `*` allows everything, a trailing `*` allows a prefix, anything else must match exactly. */
export function scopeAllowed(
  allowed: readonly string[],
  entry: string,
): boolean {
  return allowed.some((pattern) =>
    pattern === '*'
      ? true
      : pattern.endsWith('*')
        ? entry.startsWith(pattern.slice(0, -1))
        : pattern === entry,
  );
}
