import { fail } from './errors.ts';
import type { Blocker, IssueLink, Mission, MissionActivity, MissionState, Packet, PacketState } from './types.ts';

/**
 * Mission transitions. `completed` is reachable only from `reconciling`, and the
 * service only takes that edge after the completion gate passes. `completed ->
 * needs_attention` exists for drift (a required issue reopened); the historical
 * completion event is preserved in the event log.
 */
const MISSION_EDGES: Record<MissionState, MissionState[]> = {
  draft: ['active', 'cancelled'],
  active: ['paused', 'verifying', 'needs_attention', 'cancelled'],
  paused: ['active', 'cancelled'],
  verifying: ['reconciling', 'active', 'needs_attention', 'paused', 'cancelled'],
  reconciling: ['completed', 'needs_attention', 'active', 'cancelled'],
  needs_attention: ['active', 'reconciling', 'verifying', 'cancelled'],
  completed: ['needs_attention'],
  cancelled: [],
};

export function assertMissionTransition(from: MissionState, to: MissionState): void {
  if (!MISSION_EDGES[from].includes(to)) {
    fail('invalid_transition', `mission cannot move from ${from} to ${to}`, { from, to });
  }
}

export const MISSION_OPEN_STATES: MissionState[] = ['active', 'verifying', 'reconciling', 'needs_attention'];

const PACKET_EDGES: Record<PacketState, PacketState[]> = {
  pending: ['ready', 'held', 'paused', 'cancelled'],
  ready: ['leased', 'running', 'pending', 'held', 'paused', 'cancelled'],
  leased: ['running', 'recovering', 'ready', 'failed', 'review_pending', 'done', 'held', 'paused', 'cancelled'],
  running: ['recovering', 'ready', 'failed', 'review_pending', 'done', 'held', 'paused', 'cancelled', 'running'],
  recovering: ['running', 'ready', 'held', 'failed', 'review_pending', 'done', 'paused', 'cancelled'],
  held: ['ready', 'pending', 'running', 'recovering', 'cancelled', 'paused', 'failed'],
  review_pending: ['done', 'ready', 'held', 'failed', 'cancelled'],
  done: [],
  failed: ['ready', 'cancelled'],
  paused: ['ready', 'pending', 'recovering', 'cancelled'],
  cancelled: [],
};

export function assertPacketTransition(from: PacketState, to: PacketState): void {
  if (!PACKET_EDGES[from].includes(to)) {
    fail('invalid_transition', `packet cannot move from ${from} to ${to}`, { from, to });
  }
}

export const PACKET_TERMINAL: PacketState[] = ['done', 'cancelled'];

/** Whether all of a packet's dependencies are done. */
export function depsSatisfied(p: Packet, byId: Map<string, Packet>): boolean {
  return p.dependsOn.every((d) => byId.get(d)?.state === 'done');
}

/**
 * Explain an active mission: what is it doing, and what blocks which branch.
 * A blocked branch never hides that other branches are running.
 */
export function deriveActivity(
  mission: Mission,
  packets: Packet[],
  opts: { onlineRunnerCount: number; openChildMissions: number; unmetMissionDeps: string[] },
): { activity: MissionActivity; blockers: Blocker[] } {
  const blockers: Blocker[] = [];
  if (mission.state === 'completed') return { activity: 'done', blockers };
  if (mission.state === 'verifying') return { activity: 'verification_pending', blockers: [{ kind: 'verification', reason: 'outcome verification pending' }] };
  if (mission.state === 'reconciling') return { activity: 'waiting_external', blockers: mission.blockers };
  for (const dep of opts.unmetMissionDeps) blockers.push({ kind: 'dependency', ref: dep, reason: `waits for mission ${dep}` });

  const live = packets.filter((p) => !PACKET_TERMINAL.includes(p.state));
  for (const p of live) {
    if (p.state === 'held') blockers.push({ kind: 'decision', packetId: p.id, ref: p.blockedBy[0], reason: p.holdReason ?? 'waiting for a decision' });
    if (p.state === 'recovering') blockers.push({ kind: 'recovery', packetId: p.id, reason: p.holdReason ?? 'runner lost; waiting to reconcile' });
    if (p.state === 'review_pending') blockers.push({ kind: 'review', packetId: p.id, reason: p.gate?.reasons.join('; ') ?? 'gate not satisfied' });
    if (p.state === 'failed') blockers.push({ kind: 'policy', packetId: p.id, reason: 'attempts exhausted; needs a retry decision' });
  }
  const has = (s: PacketState) => live.some((p) => p.state === s);
  let activity: MissionActivity;
  if (opts.unmetMissionDeps.length > 0) activity = 'waiting_dependency';
  else if (has('running') || has('leased')) activity = 'running';
  else if (has('ready') && opts.onlineRunnerCount === 0) {
    activity = 'waiting_runner';
    blockers.push({ kind: 'runner', reason: 'waiting for an eligible runner (no model work runs without one)' });
  } else if (has('ready')) activity = 'queued';
  else if (has('recovering')) activity = 'waiting_runner';
  else if (has('held')) activity = 'waiting_decision';
  else if (opts.openChildMissions > 0) activity = 'waiting_dependency';
  else if (packets.length === 0) activity = 'planning';
  else if (has('pending')) activity = 'waiting_dependency';
  else activity = 'idle';
  return { activity, blockers };
}

export interface CompletionCheck {
  ok: boolean;
  missing: string[];
}

/** Gate for active -> verifying: all work done and all child missions completed. */
export function workComplete(packets: Packet[], children: Mission[]): CompletionCheck {
  const missing: string[] = [];
  if (packets.length === 0 && children.length === 0) missing.push('no work packets or child missions');
  for (const p of packets) if (p.state !== 'done' && p.state !== 'cancelled') missing.push(`packet ${p.id} is ${p.state}`);
  if (packets.length > 0 && packets.every((p) => p.state === 'cancelled')) missing.push('all packets cancelled');
  for (const c of children) if (c.state !== 'completed' && c.state !== 'cancelled') missing.push(`child mission ${c.id} is ${c.state}`);
  return { ok: missing.length === 0, missing };
}

/**
 * Reconciliation invariant: every required link is verified closed by its provider,
 * attested closed by a human (link-only), or has an approved exemption.
 */
export function linksReconciled(links: IssueLink[]): CompletionCheck {
  const missing: string[] = [];
  for (const l of links) {
    if (l.role !== 'required') continue;
    if (l.exemption) continue;
    if (l.observedState === 'closed') continue;
    missing.push(`required issue ${l.url} is ${l.observedState}`);
  }
  return { ok: missing.length === 0, missing };
}
