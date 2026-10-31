import type { WorkPacket } from '../core/types.js';
import { isNarrowerPattern, matchesPattern } from '../policy/patterns.js';

/** `*` matches `/` and `..` like any other text, so a path that climbs out of a subtree has to be refused first. */
export function hasTraversal(value: string): boolean {
  return value.split(/[\\/]/).some((segment) => segment === '..');
}

/** A scope of `*` declares nothing, so it never vouches for anything. */
const declared = (pattern: string): boolean =>
  pattern !== '' && !/^\*+$/.test(pattern) && !hasTraversal(pattern);

/**
 * True when what a request claims to touch lies inside what the packet itself declared. The
 * claim comes from the requester, so it is checked against the packet rather than believed.
 */
export function packetCovers(packet: WorkPacket, scope: string): boolean {
  return (
    !hasTraversal(scope) &&
    packet.scope.some(
      (pattern) => declared(pattern) && matchesPattern(pattern, scope),
    )
  );
}

/**
 * True when every scope the packet declares, and the requested scope, lie inside the scope of
 * packets that were already authorized. A packet cannot vouch for its own scope.
 */
export function withinAuthorizedScope(
  packet: WorkPacket | undefined,
  siblings: readonly WorkPacket[],
  scope: string,
): boolean {
  const authorized = siblings
    .filter((p) => p.authorization !== null && p.id !== packet?.id)
    .flatMap((p) => p.scope)
    .filter(declared);
  if (
    hasTraversal(scope) ||
    !authorized.some((p) => matchesPattern(p, scope))
  ) {
    return false;
  }
  return (
    packet === undefined ||
    (packet.scope.length > 0 &&
      packet.scope.every(
        (entry) =>
          declared(entry) &&
          authorized.some((pattern) => isNarrowerPattern(entry, pattern)),
      ))
  );
}
