import { matchPattern } from './policy.ts';
import type { Mission, Packet, Runner } from './types.ts';

export interface Candidate {
  packet: Packet;
  mission: Mission;
  /** Runner id that produced the packet's checkpoint, if any (affinity). */
  previousRunnerId?: string;
}

/** Why a runner cannot take a packet, or null when it can. */
export function ineligibility(runner: Runner, packet: Packet): string | null {
  if (runner.status !== 'online') return `runner is ${runner.status}`;
  if (!runner.engines.includes(packet.engine)) return `runner lacks engine ${packet.engine}`;
  const missing = packet.capabilities.filter((c) => !runner.capabilities.includes(c));
  if (missing.length) return `runner lacks capabilities ${missing.join(', ')}`;
  if (runner.allowedScopes.length > 0 && !runner.allowedScopes.some((s) => matchPattern(s, packet.execScope))) {
    return `runner is not allowed to work on ${packet.execScope}`;
  }
  return null;
}

/**
 * Pick the best eligible candidate for a runner: affinity to its own checkpoint
 * first, then mission priority (lower number is more urgent), then age.
 * `busyScopes` are execution scopes another attempt currently holds.
 */
export function selectCandidate(runner: Runner, candidates: Candidate[], busyScopes: Set<string>): Candidate | null {
  const eligible = candidates.filter((c) => !busyScopes.has(c.packet.execScope) && ineligibility(runner, c.packet) === null);
  eligible.sort((a, b) => {
    const aff = Number(b.previousRunnerId === runner.id) - Number(a.previousRunnerId === runner.id);
    if (aff !== 0) return aff;
    if (a.mission.priority !== b.mission.priority) return a.mission.priority - b.mission.priority;
    return a.packet.createdAt.localeCompare(b.packet.createdAt);
  });
  return eligible[0] ?? null;
}

/** Exponential retry backoff, capped. */
export function backoffMs(attempt: number, baseMs = 30_000, capMs = 30 * 60_000): number {
  return Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
}

/** Derive the mutable execution scope a packet writes to. One writer per scope. */
export function execScopeFor(missionId: string, packetId: string, scope: { repo?: string; branch?: string }): string {
  if (scope.repo) return `repo:${scope.repo.toLowerCase()}#${scope.branch ?? `tower/${missionId}`}`;
  return `packet:${packetId}`;
}
