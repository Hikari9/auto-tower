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

// A segment may start with a dot (`.github`) but not end with one, which also rules out `.` and
// `..`, and a name that ends in a dot is the same directory on filesystems that drop it.
const SEGMENT = /^[a-z0-9._-]*[a-z0-9_-]$/;

/**
 * `Repo`, `repo/` and `repo.git` are one repository. Returns undefined for a name that is not a
 * plain path of segments: an empty, `.` or `..` segment, or a character outside the plain set.
 * Applying it to its own output changes nothing, so a key never depends on how often it ran.
 */
function normalise(name: string): string | undefined {
  const segments = name.trim().toLowerCase().split('/');
  while (segments.length > 1 && segments[segments.length - 1] === '') {
    segments.pop();
  }
  const last = segments.length - 1;
  let tail = segments[last] ?? '';
  while (tail.endsWith('.git')) {
    tail = tail.slice(0, -4);
  }
  segments[last] = tail;
  if (
    segments.join('/').length > 128 ||
    segments.length > 16 ||
    segments.some((segment) => segment === '..' || !SEGMENT.test(segment))
  ) {
    return undefined;
  }
  return segments.join('/');
}

const PREFIXED = /^\s*(cap|repo|worktree)\s*:([\s\S]*)$/i;

/** The kind and value of a `cap:`, `repo:` or `worktree:` entry, whatever its case or spacing. */
function prefixed(
  entry: string,
): { kind: 'cap' | 'repo' | 'worktree'; value: string } | undefined {
  const match = PREFIXED.exec(entry);
  return match === null
    ? undefined
    : {
        kind: (match[1] ?? '').toLowerCase() as 'cap' | 'repo' | 'worktree',
        value: match[2] ?? '',
      };
}

export function requirementsOf(
  missionId: string,
  packet: Pick<WorkPacket, 'id' | 'scope'>,
): PacketRequirements {
  const capabilities: string[] = [];
  const scopes: string[] = [];
  const repos = new Set<string>();
  const worktrees = new Set<string>();
  let invalid: string | undefined;
  for (const entry of packet.scope) {
    const found = prefixed(entry);
    if (found?.kind === 'cap') {
      capabilities.push(found.value);
      continue;
    }
    scopes.push(entry);
    if (found === undefined) {
      continue;
    }
    const plain = normalise(found.value);
    if (plain === undefined) {
      invalid = 'a repo or worktree name is not a plain name';
    } else {
      (found.kind === 'repo' ? repos : worktrees).add(plain);
    }
  }
  if (invalid === undefined) {
    if (repos.size > 1) {
      invalid = 'it names more than one repo';
    } else if (worktrees.size > 1) {
      invalid = 'it names more than one worktree';
    } else if (worktrees.size === 1 && repos.size === 0) {
      invalid = 'it names a worktree but no repo';
    }
  }
  const repo = [...repos][0];
  // Without a declared repo nothing is shared, so the packet only excludes itself.
  const scopeKey =
    repo === undefined || invalid !== undefined
      ? `packet:${missionId}/${packet.id}`
      : `repo:${repo}#worktree:${[...worktrees][0] ?? 'default'}`;
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
