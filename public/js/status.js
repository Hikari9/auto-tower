/**
 * Maps API states to labels and visual tones. Every tone also has a text label,
 * so color is never the only signal. Verified and self-reported evidence use
 * different border styles as well as different words.
 */

/** @type {Record<string, {label: string, tone: string}>} */
export const MISSION_STATES = {
  draft: { label: 'Draft', tone: 'neutral' },
  planning: { label: 'Planning', tone: 'neutral' },
  ready: { label: 'Ready', tone: 'neutral' },
  running: { label: 'Running', tone: 'active' },
  'waiting-runner': { label: 'Waiting for runner', tone: 'waiting' },
  'waiting-decision': { label: 'Waiting for decision', tone: 'blocked' },
  'waiting-external': { label: 'Waiting on external work', tone: 'blocked' },
  verifying: { label: 'Verification pending', tone: 'verify' },
  reconciling: { label: 'Reconciling', tone: 'verify' },
  completed: { label: 'Completed', tone: 'done' },
  'needs-attention': { label: 'Needs attention', tone: 'alert' },
  cancelled: { label: 'Cancelled', tone: 'muted' },
};

/** @type {Record<string, {label: string, tone: string}>} */
export const PACKET_STATES = {
  pending: { label: 'Pending', tone: 'neutral' },
  ready: { label: 'Ready', tone: 'neutral' },
  leased: { label: 'Leased to runner', tone: 'active' },
  running: { label: 'Running', tone: 'active' },
  reported: { label: 'Self-reported, verification pending', tone: 'verify' },
  verified: { label: 'Verified by Tower', tone: 'done' },
  failed: { label: 'Failed', tone: 'alert' },
  cancelled: { label: 'Cancelled', tone: 'muted' },
};

/** Lease statuses, including the interrupted and fenced states a reconnecting runner resolves. */
export const LEASE_STATES = {
  held: { label: 'Running', tone: 'active' },
  recovering: { label: 'Interrupted, recovering', tone: 'verify' },
  completed: { label: 'Completed', tone: 'done' },
  fenced: { label: 'Fenced (stale attempt rejected)', tone: 'alert' },
  cancelled: { label: 'Cancelled', tone: 'muted' },
  released: { label: 'Released', tone: 'muted' },
};

/** Runner statuses. `paused` is a runner state, not a mission state. */
export const RUNNER_STATES = {
  active: { label: 'Active', tone: 'done' },
  paused: { label: 'Paused', tone: 'waiting' },
  quarantined: { label: 'Quarantined', tone: 'alert' },
};

/**
 * @param {Record<string, {label: string, tone: string}>} table
 * @param {string} key
 */
export function describe(table, key) {
  return Object.hasOwn(table, key)
    ? table[key]
    : { label: key, tone: 'neutral' };
}

/**
 * Who vouches for a packet's outcome. Tower verification is the only source of
 * "verified". A runner report alone stays "self-reported".
 *
 * @param {{verification?: unknown, status?: string}} packet
 * @param {{report?: unknown} | null | undefined} attempt
 * @returns {{kind: 'verified' | 'self-reported' | 'none', label: string}}
 */
export function evidenceOf(packet, attempt) {
  if (packet.verification) {
    return { kind: 'verified', label: 'Verified by Tower' };
  }
  if (attempt?.report) {
    return {
      kind: 'self-reported',
      label: 'Self-reported by runner (not verified)',
    };
  }
  return { kind: 'none', label: 'No evidence yet' };
}

/**
 * Names of unverified packets a packet waits on. Empty when nothing blocks it.
 *
 * @param {{dependsOn?: string[], status?: string}} packet
 * @param {Map<string, {title: string, verification?: unknown}>} byId
 * @returns {string[]}
 */
export function unmetDependencies(packet, byId) {
  if (packet.status === 'verified' || packet.status === 'cancelled') {
    return [];
  }
  return (packet.dependsOn ?? [])
    .map((id) => byId.get(id))
    .filter((dep) => dep !== undefined && !dep.verification)
    .map((dep) => dep.title);
}
