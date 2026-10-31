import { fail, TowerError } from '../domain/errors.ts';
import type { Actor, Alternative, Decision, Mission, OnApprove, Packet, PolicyRule, RequiredAuthority } from '../domain/types.ts';
import { SPECS } from '../store/codec.ts';
import type { UnitOfWork } from '../store/uow.ts';
import { requireScope } from './auth.ts';
import { dedupe } from './missions.ts';
import type { Tower } from './tower.ts';

export interface RaiseInput {
  missionId: string;
  packetIds?: string[];
  category: string;
  urgency?: Decision['urgency'];
  audience: Decision['audience'];
  question: string;
  alternatives?: Alternative[];
  recommendation?: Decision['recommendation'];
  consequences?: string;
  requiredAuthority: RequiredAuthority;
  evidence?: string[];
  affectedScope?: string;
  onApprove?: OnApprove;
  dedupeKey?: string;
}

export interface AnswerInput {
  approved: boolean;
  alternativeId?: string;
  note?: string;
}

export class DecisionService {
  private readonly t: Tower;

  constructor(t: Tower) {
    this.t = t;
  }

  /**
   * Raise a decision, or link the packets to an identical open one (dedupe).
   * Linked packets are held; nothing else in the mission or workspace stops.
   */
  async raiseTx(tx: UnitOfWork, input: RaiseInput): Promise<Decision> {
    const ws = tx.workspaceId;
    const key = input.dedupeKey ?? `${input.missionId}|${input.category}|${input.requiredAuthority.action}|${input.requiredAuthority.resource}`;
    const existing = await this.t.repo.openDecisionByDedupe(ws, key);
    const packetIds = input.packetIds ?? [];
    if (existing) {
      for (const pid of packetIds.filter((p) => !existing.linkedPackets.includes(p))) {
        tx.run('INSERT OR IGNORE INTO decision_links (decision_id, packet_id) VALUES (?, ?)', existing.id, pid);
      }
      tx.event({ stream: 'decision', id: existing.id, expected: existing.version, type: 'decision.linked', missionId: existing.missionId, payload: { packetIds } });
      tx.run('UPDATE decisions SET version = ? WHERE id = ?', existing.version + 1, existing.id);
      return { ...existing, version: existing.version + 1, linkedPackets: dedupe([...existing.linkedPackets, ...packetIds]) };
    }
    const d: Decision = {
      id: this.t.id('dec'),
      workspaceId: ws,
      missionId: input.missionId,
      category: input.category,
      urgency: input.urgency ?? 'normal',
      audience: input.audience,
      question: input.question,
      alternatives: input.alternatives ?? [
        { id: 'approve', label: 'Approve' },
        { id: 'decline', label: 'Decline' },
      ],
      recommendation: input.recommendation ?? null,
      consequences: input.consequences ?? '',
      requiredAuthority: input.requiredAuthority,
      evidence: input.evidence ?? [],
      affectedScope: input.affectedScope ?? '',
      onApprove: input.onApprove ?? {},
      dedupeKey: key,
      status: 'open',
      answer: null,
      answeredBy: null,
      answeredAt: null,
      ruleRef: null,
      linkedPackets: packetIds,
      version: 0,
      createdAt: tx.now,
    };
    const saved = tx.save('decision', SPECS.decision, d, 'decision.raised', {
      missionId: d.missionId,
      payload: { category: d.category, audience: d.audience, urgency: d.urgency, question: d.question, requiredAuthority: d.requiredAuthority },
    });
    for (const pid of packetIds) tx.run('INSERT OR IGNORE INTO decision_links (decision_id, packet_id) VALUES (?, ?)', d.id, pid);
    if (d.urgency === 'urgent') tx.event({ stream: 'decision', id: d.id, expected: 1, type: 'decision.notify_requested', missionId: d.missionId, payload: { channel: 'owner-opt-in' } });
    return d.urgency === 'urgent' ? { ...saved, version: 2 } : saved;
  }

  /** Put packets on hold for a decision. */
  holdPacketsTx(tx: UnitOfWork, packets: Packet[], decisionId: string, reason: string): void {
    for (const p of packets) {
      if (p.state === 'held' && p.blockedBy.includes(decisionId)) continue;
      tx.save('packet', SPECS.packet, { ...p, state: 'held' as const, holdReason: reason, blockedBy: dedupe([...p.blockedBy, decisionId]) }, 'packet.held', {
        missionId: p.missionId,
        payload: { decisionId, reason },
      });
    }
  }

  /** Human or chief raises an explicit executive choice on a mission. */
  async raise(actor: Actor, input: Omit<RaiseInput, 'audience'> & { audience?: Decision['audience'] }): Promise<Decision> {
    requireScope(actor, 'missions:write');
    const ws = actor.principal.workspaceId;
    await this.t.repo.mission(ws, input.missionId);
    return this.t.retrying(async () => {
      const tx = this.t.uow(actor);
      const d = await this.raiseTx(tx, { ...input, audience: input.audience ?? 'human' });
      const packets = await Promise.all((input.packetIds ?? []).map((id) => this.t.repo.packet(ws, id)));
      this.holdPacketsTx(tx, packets.filter((p) => !['done', 'cancelled'].includes(p.state)), d.id, d.question);
      await tx.commit(this.t.db);
      await this.t.missions.refresh(ws, input.missionId);
      return this.t.repo.decision(ws, d.id);
    });
  }

  async list(actor: Actor, f: { status?: string; missionId?: string; audience?: string } = {}) {
    requireScope(actor, 'decisions:read');
    return this.t.repo.decisions(actor.principal.workspaceId, f);
  }

  async get(actor: Actor, id: string) {
    requireScope(actor, 'decisions:read');
    return this.t.repo.decision(actor.principal.workspaceId, id);
  }

  /**
   * Answer a decision. Humans may answer anything. A chief may answer only
   * chief-audience decisions, and may approve only when a current explicit rule
   * covers the exact action, resource and risk; otherwise the decision moves to
   * the human inbox. Approval resumes only the linked branches.
   */
  async answer(actor: Actor, id: string, input: AnswerInput, idempotencyKey?: string): Promise<Decision> {
    const isHuman = actor.principal.kind === 'human';
    requireScope(actor, isHuman ? 'decisions:answer' : 'decisions:answer:chief');
    return this.t.idempotent(actor, idempotencyKey, { op: 'decision.answer', id, input }, async () => {
      const ws = actor.principal.workspaceId;
      const result = await this.t.retrying(() => this.answerOnce(actor, id, input));
      if (result.escalated) {
        throw new TowerError('policy_denied', `no current delegated rule covers this approval; moved to the owner's Decision Inbox`, { decisionId: id, policy: result.policy });
      }
      const d = await this.t.repo.decision(ws, id);
      if (isHuman && input.approved) await this.t.policy.observeApproval(actor, d);
      await this.t.missions.refresh(ws, d.missionId);
      return d;
    });
  }

  private async answerOnce(actor: Actor, id: string, input: AnswerInput): Promise<{ escalated: boolean; policy?: unknown }> {
    const ws = actor.principal.workspaceId;
    const d = await this.t.repo.decision(ws, id);
    if (d.status !== 'open') fail('conflict', `decision is already ${d.status}`, { answer: d.answer, answeredBy: d.answeredBy });
    if (input.alternativeId && !d.alternatives.some((a) => a.id === input.alternativeId)) fail('invalid', `unknown alternative ${input.alternativeId}`);
    const isHuman = actor.principal.kind === 'human';
    if (!isHuman && d.audience !== 'chief') fail('forbidden', 'only the owner can answer this decision');

    const mission = await this.t.repo.mission(ws, d.missionId);
    const tx = this.t.uow(actor);
    let ruleRef: Decision['ruleRef'] = null;
    let policy;
    let matchedRule: PolicyRule | undefined;
    if (!isHuman && input.approved) {
      const auth = await this.t.policy.authorize(ws, { grantee: 'chief', ...d.requiredAuthority, missionId: d.missionId });
      policy = auth.evaluation;
      matchedRule = auth.rule;
      if (!policy.allowed || policy.basis !== 'rule' || !policy.ruleId) {
        tx.save('decision', SPECS.decision, { ...d, audience: 'human' as const }, 'decision.escalated', {
          missionId: d.missionId,
          policy,
          payload: { reason: 'chief approval not covered by a current delegated rule', note: input.note ?? '' },
        });
        await tx.commit(this.t.db);
        return { escalated: true, policy };
      }
      ruleRef = { ruleId: policy.ruleId, policyVersion: policy.policyVersion };
      this.t.policy.recordUseTx(tx, matchedRule!, { decisionId: d.id });
    }

    const answer = { approved: input.approved, ...(input.alternativeId ? { alternativeId: input.alternativeId } : {}), ...(input.note ? { note: input.note } : {}) };
    tx.save('decision', SPECS.decision, { ...d, status: 'answered' as const, answer, answeredBy: actor.principal.id, answeredAt: tx.now, ruleRef }, 'decision.answered', {
      missionId: d.missionId,
      ...(policy ? { policy } : {}),
      payload: { ...answer, byKind: actor.principal.kind },
    });

    let m: Mission = mission;
    if (input.approved && d.onApprove.extendAuthority) {
      const ext = d.onApprove.extendAuthority;
      m = tx.save(
        'mission',
        SPECS.mission,
        { ...m, authority: { actions: dedupe([...m.authority.actions, ...ext.actions]), resources: dedupe([...m.authority.resources, ...ext.resources]) } },
        'mission.authority_extended',
        { missionId: m.id, payload: { ...ext, decisionId: d.id, ruleRef } },
      );
    }
    if (input.approved && d.onApprove.createPacket) {
      const pkt = this.t.missions.buildPacket(m, d.onApprove.createPacket, 'expansion');
      tx.save('packet', SPECS.packet, pkt, 'packet.created', { missionId: m.id, payload: { title: pkt.title, origin: 'expansion', decisionId: d.id } });
    }
    // Release only the branches that waited on this decision.
    for (const pid of d.linkedPackets) {
      const p = await this.t.repo.packet(ws, pid);
      if (p.state !== 'held' || !p.blockedBy.includes(d.id)) continue;
      const rest = p.blockedBy.filter((b) => b !== d.id);
      if (rest.length) {
        tx.save('packet', SPECS.packet, { ...p, blockedBy: rest }, 'packet.decision_cleared', { missionId: p.missionId, payload: { decisionId: d.id } });
        continue;
      }
      const attempt = p.currentAttemptId ? await this.t.repo.attempt(ws, p.currentAttemptId) : null;
      const live = attempt && ['leased', 'running'].includes(attempt.state);
      const lost = attempt?.state === 'lost';
      // Only an approved recovery decision may restart lost work elsewhere. Any other answer
      // leaves lost work recovering: it waits for its runner or a portable checkpoint.
      const restart = d.category === 'recovery' && input.approved;
      const next = live ? 'running' : restart || (!lost && d.category !== 'recovery') ? 'ready' : 'recovering';
      tx.save('packet', SPECS.packet, { ...p, state: next as Packet['state'], holdReason: null, blockedBy: [] }, 'packet.released', {
        missionId: p.missionId,
        payload: { decisionId: d.id, approved: input.approved },
      });
    }
    await tx.commit(this.t.db);
    return { escalated: false };
  }

  /** A chief hands a decision to the owner. */
  async escalate(actor: Actor, id: string, note = ''): Promise<Decision> {
    requireScope(actor, 'decisions:read');
    const ws = actor.principal.workspaceId;
    const d = await this.t.repo.decision(ws, id);
    if (d.status !== 'open') fail('conflict', `decision is already ${d.status}`);
    if (d.audience === 'human') return d;
    const tx = this.t.uow(actor);
    tx.save('decision', SPECS.decision, { ...d, audience: 'human' as const }, 'decision.escalated', { missionId: d.missionId, payload: { note } });
    await tx.commit(this.t.db);
    return this.t.repo.decision(ws, id);
  }
}
