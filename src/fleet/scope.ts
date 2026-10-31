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
}

export function requirementsOf(
  missionId: string,
  packet: Pick<WorkPacket, 'id' | 'scope'>,
): PacketRequirements {
  const capabilities: string[] = [];
  const scopes: string[] = [];
  let repo: string | undefined;
  let worktree: string | undefined;
  for (const entry of packet.scope) {
    if (entry.startsWith('cap:')) {
      capabilities.push(entry.slice(4));
      continue;
    }
    scopes.push(entry);
    if (entry.startsWith('repo:') && repo === undefined) {
      repo = entry.slice(5);
    } else if (entry.startsWith('worktree:') && worktree === undefined) {
      worktree = entry.slice(9);
    }
  }
  // Without a declared repo nothing is shared, so the packet only excludes itself.
  const scopeKey =
    repo === undefined
      ? `packet:${missionId}/${packet.id}`
      : `repo:${repo}#worktree:${worktree ?? 'default'}`;
  return { capabilities, scopes, scopeKey };
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
