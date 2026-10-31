import { execScopeFor } from '../domain/broker.ts';
import { fail } from '../domain/errors.ts';
import { assertMissionTransition, depsSatisfied, deriveActivity, workComplete } from '../domain/lifecycle.ts';
import { envelopeCovers, isSensitive } from '../domain/policy.ts';
import { RISK_ORDER } from '../domain/types.ts';
import type { Actor, AuthorityEnvelope, DodItem, Mission, MissionState, NewPacketInput, Packet, Risk } from '../domain/types.ts';
import { SPECS } from '../store/codec.ts';
import { requireScope } from './auth.ts';
import type { Tower } from './tower.ts';

export interface CreateMissionInput {
  title: string;
  intent: string;
  outcome: string;
  constraints?: string[];
  risks?: string[];
  risk?: Risk;
  size?: string;
  definitionOfDone?: string[];
  acceptance?: string[];
  authority?: AuthorityEnvelope;
  priority?: number;
  parentId?: string;
  dependsOn?: string[];
  links?: { url: string; role?: 'required' | 'optional' | 'reference'; title?: string; description?: string }[];
  packets?: (NewPacketInput & { dependsOnIndex?: number[] })[];
  source?: string;
  start?: boolean;
}

export interface MissionPatch {
  title?: string;
  outcome?: string;
  priority?: number;
  constraints?: string[];
  risks?: string[];
  acceptance?: string[];
  dodDone?: { id: string; done: boolean; evidenceId?: string }[];
  addDod?: string[];
  dependsOn?: string[];
}

/** Every action a packet's scope implies; used to keep planned work inside the envelope. */
export function packetResources(p: { scope?: { repo?: string } }): string[] {
  return p.scope?.repo ? [`repo:${p.scope.repo.toLowerCase()}`] : [];
}

export class MissionService {
  private readonly t: Tower;

  constructor(t: Tower) {
    this.t = t;
  }

  async create(actor: Actor, input: CreateMissionInput, idempotencyKey?: string): Promise<Mission> {
    requireScope(actor, 'missions:write');
    return this.t.idempotent(actor, idempotencyKey, { op: 'mission.create', input }, () => this.createInner(actor, input));
  }

  private async createInner(actor: Actor, input: CreateMissionInput): Promise<Mission> {
    const ws = actor.principal.workspaceId;
    const workspace = await this.t.repo.workspace(ws);
    if (!input.title?.trim() || !input.outcome?.trim()) fail('invalid', 'title and outcome are required');
    const risk: Risk = input.risk ?? 'medium';
    const authority: AuthorityEnvelope = {
      actions: dedupe(input.authority?.actions ?? []),
      resources: dedupe(input.authority?.resources ?? []),
    };
    if (actor.principal.kind !== 'human') {
      const sensitive = authority.actions.filter(isSensitive);
      if (sensitive.length) fail('policy_denied', `only a human can put sensitive actions in a mission envelope: ${sensitive.join(', ')}`);
    }
    if (input.parentId) await this.t.repo.mission(ws, input.parentId);
    for (const dep of input.dependsOn ?? []) await this.t.repo.mission(ws, dep);

    const now = this.t.now();
    const tx = this.t.uow(actor);
    const dod: DodItem[] = (input.definitionOfDone ?? []).map((text, i) => ({ id: `dod${i + 1}`, text, done: false }));
    let mission: Mission = {
      id: this.t.id('msn'),
      workspaceId: ws,
      parentId: input.parentId ?? null,
      title: input.title.trim(),
      intent: input.intent ?? '',
      outcome: input.outcome.trim(),
      constraints: input.constraints ?? [],
      risks: input.risks ?? [],
      risk,
      size: input.size ?? 'm',
      dod,
      acceptance: input.acceptance ?? [],
      authority,
      priority: input.priority ?? 50,
      source: input.source ?? actor.principal.kind,
      createdBy: actor.principal.id,
      state: 'draft',
      activity: 'planning',
      blockers: [],
      dependsOn: input.dependsOn ?? [],
      verification: null,
      discrepancies: [],
      policyVersionRef: workspace.policyVersion,
      version: 0,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };

    // Planned packets must stay inside the envelope. A human's plan widens it explicitly.
    const packetInputs = input.packets ?? [];
    const outside = packetInputs.flatMap(packetResources).filter((r) => !envelopeCovers({ actions: ['*'], resources: mission.authority.resources }, '*', r));
    if (outside.length) {
      if (actor.principal.kind !== 'human') fail('policy_denied', `planned work is outside the mission envelope: ${outside.join(', ')}`);
      mission.authority = { ...mission.authority, resources: dedupe([...mission.authority.resources, ...outside]) };
    }

    mission = tx.save('mission', SPECS.mission, mission, 'mission.created', {
      missionId: mission.id,
      payload: { title: mission.title, risk, authority: mission.authority, parentId: mission.parentId, source: mission.source },
    });

    const ids: string[] = [];
    for (const p of packetInputs) {
      const deps = [...(p.dependsOn ?? []), ...(p.dependsOnIndex ?? []).map((i) => ids[i] ?? fail('invalid', `dependsOnIndex ${i} must refer to an earlier packet`))];
      const packet = this.buildPacket(mission, { ...p, dependsOn: deps }, 'planned');
      ids.push(packet.id);
      tx.save('packet', SPECS.packet, packet, 'packet.created', { missionId: mission.id, payload: { title: packet.title, origin: 'planned' } });
    }
    for (const l of input.links ?? []) await this.t.issues.addLinkTx(tx, mission, l);

    await tx.commit(this.t.db);
    if (input.start) mission = await this.start(actor, mission.id);
    return mission;
  }

  buildPacket(mission: Mission, input: NewPacketInput, origin: Packet['origin']): Packet {
    if (!input.title?.trim() || !input.goal?.trim()) fail('invalid', 'packet title and goal are required');
    const id = this.t.id('pkt');
    const risk = input.risk ?? mission.risk;
    const now = this.t.now();
    return {
      id,
      workspaceId: mission.workspaceId,
      missionId: mission.id,
      title: input.title.trim(),
      goal: input.goal.trim(),
      scope: input.scope ?? {},
      acceptance: input.acceptance ?? [],
      engine: input.engine ?? 'auto-office',
      capabilities: input.capabilities ?? [],
      risk,
      // Review is risk-based: high and critical work always needs an independent reviewer.
      reviewRequired: input.reviewRequired ?? RISK_ORDER[risk] >= RISK_ORDER.high,
      dependsOn: input.dependsOn ?? [],
      kind: input.kind ?? 'work',
      origin,
      state: 'pending',
      holdReason: null,
      blockedBy: [],
      execScope: execScopeFor(mission.id, id, input.scope ?? {}),
      currentAttemptId: null,
      attemptsCount: 0,
      maxAttempts: input.maxAttempts ?? 3,
      nextEligibleAt: null,
      checkpoint: null,
      result: null,
      gate: null,
      version: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  async get(actor: Actor, id: string) {
    requireScope(actor, 'missions:read');
    const ws = actor.principal.workspaceId;
    const mission = await this.t.repo.mission(ws, id);
    const [packets, attempts, decisions, links, evidence, children, events] = await Promise.all([
      this.t.repo.packets(ws, id),
      this.t.repo.attemptsFor(ws, { missionId: id }),
      this.t.repo.decisions(ws, { missionId: id }),
      this.t.repo.links(ws, id),
      this.t.repo.evidence(ws, id),
      this.t.repo.children(ws, id),
      this.t.repo.events(ws, { missionId: id, limit: 200 }),
    ]);
    return { mission, packets, attempts, decisions, links, evidence, children, events };
  }

  /** Missions with the overview extras: who owns each and how much of its work is done. */
  async list(actor: Actor, f: { states?: MissionState[]; q?: string; parentId?: string | null; limit?: number } = {}) {
    requireScope(actor, 'missions:read');
    const ws = actor.principal.workspaceId;
    const [missions, counts, principals] = await Promise.all([
      this.t.repo.missions(ws, f),
      this.t.db.all<{ mission_id: string; total: number; done: number }>(
        "SELECT mission_id, COUNT(*) AS total, SUM(CASE WHEN state = 'done' THEN 1 ELSE 0 END) AS done FROM packets WHERE workspace_id = ? AND state != 'cancelled' GROUP BY mission_id",
        [ws],
      ),
      this.t.repo.principals(ws),
    ]);
    const byMission = new Map(counts.map((c) => [c.mission_id, c]));
    const names = new Map(principals.map((p) => [p.id, p.name]));
    return missions.map((m) => ({ ...m, ownerName: names.get(m.createdBy) ?? m.createdBy, progress: { done: byMission.get(m.id)?.done ?? 0, total: byMission.get(m.id)?.total ?? 0 } }));
  }

  async update(actor: Actor, id: string, expectedVersion: number, patch: MissionPatch): Promise<Mission> {
    requireScope(actor, 'missions:write');
    const ws = actor.principal.workspaceId;
    const m = await this.t.repo.mission(ws, id);
    if (m.version !== expectedVersion) fail('conflict', `mission is at version ${m.version}, not ${expectedVersion}`, { currentVersion: m.version });
    if (m.state === 'cancelled') fail('invalid_transition', 'cancelled missions are read-only');
    const next: Mission = { ...m };
    if (patch.title !== undefined) next.title = patch.title;
    if (patch.outcome !== undefined) next.outcome = patch.outcome;
    if (patch.priority !== undefined) next.priority = patch.priority;
    if (patch.constraints) next.constraints = patch.constraints;
    if (patch.risks) next.risks = patch.risks;
    if (patch.acceptance) next.acceptance = patch.acceptance;
    if (patch.addDod?.length) next.dod = [...next.dod, ...patch.addDod.map((text, i) => ({ id: `dod${m.dod.length + i + 1}`, text, done: false }))];
    if (patch.dodDone) {
      next.dod = next.dod.map((d) => {
        const u = patch.dodDone!.find((x) => x.id === d.id);
        return u ? { ...d, done: u.done, ...(u.evidenceId ? { evidenceId: u.evidenceId } : {}) } : d;
      });
    }
    if (patch.dependsOn) {
      for (const dep of patch.dependsOn) await this.t.repo.mission(ws, dep);
      if (await this.wouldCycle(ws, id, patch.dependsOn)) fail('invalid', 'mission dependencies would form a cycle');
      next.dependsOn = patch.dependsOn;
    }
    const tx = this.t.uow(actor);
    const saved = tx.save('mission', SPECS.mission, next, 'mission.updated', { missionId: id, payload: patch });
    await tx.commit(this.t.db);
    await this.refresh(ws, id);
    return saved;
  }

  private async wouldCycle(ws: string, id: string, deps: string[]): Promise<boolean> {
    const seen = new Set<string>();
    const stack = [...deps];
    while (stack.length) {
      const cur = stack.pop()!;
      if (cur === id) return true;
      if (seen.has(cur)) continue;
      seen.add(cur);
      stack.push(...(await this.t.repo.mission(ws, cur)).dependsOn);
    }
    return false;
  }

  /** draft -> active. Humans authorize directly; a chief needs an explicit mission.start grant. */
  async start(actor: Actor, id: string): Promise<Mission> {
    requireScope(actor, 'missions:write');
    const ws = actor.principal.workspaceId;
    return this.t.retrying(async () => {
      const m = await this.t.repo.mission(ws, id);
      if (m.state === 'active') return m;
      assertMissionTransition(m.state, 'active');
      let policy;
      if (actor.principal.kind !== 'human') {
        policy = await this.t.policy.evaluate(ws, { grantee: 'chief', action: 'mission.start', resource: `mission:${m.id}`, risk: m.risk });
        if (!policy.allowed) fail('policy_denied', `starting this mission needs the owner or a mission.start grant: ${policy.reason}`, { policy });
      }
      const tx = this.t.uow(actor);
      tx.save('mission', SPECS.mission, { ...m, state: 'active' as const }, 'mission.started', { missionId: id, ...(policy ? { policy } : {}) });
      await tx.commit(this.t.db);
      return this.refresh(ws, id);
    });
  }

  async pause(actor: Actor, id: string, reason = ''): Promise<Mission> {
    return this.simpleTransition(actor, id, 'paused', 'mission.paused', { reason });
  }

  async resume(actor: Actor, id: string): Promise<Mission> {
    const ws = actor.principal.workspaceId;
    const m = await this.t.repo.mission(ws, id);
    if (m.state === 'needs_attention') {
      // Re-enter whichever stage still has unmet work.
      const packets = await this.t.repo.packets(ws, id);
      const children = await this.t.repo.children(ws, id);
      const target: MissionState = !workComplete(packets, children).ok ? 'active' : m.verification?.verdict === 'pass' ? 'reconciling' : 'verifying';
      return this.simpleTransition(actor, id, target, 'mission.resumed', {});
    }
    return this.simpleTransition(actor, id, 'active', 'mission.resumed', {});
  }

  private async simpleTransition(actor: Actor, id: string, to: MissionState, type: string, payload: Record<string, unknown>): Promise<Mission> {
    requireScope(actor, 'missions:write');
    const ws = actor.principal.workspaceId;
    await this.t.retrying(async () => {
      const m = await this.t.repo.mission(ws, id);
      if (m.state === to) return;
      assertMissionTransition(m.state, to);
      const tx = this.t.uow(actor);
      tx.save('mission', SPECS.mission, { ...m, state: to }, type, { missionId: id, payload });
      // Pausing a mission pauses its undispatched work; running attempts get a pause directive.
      if (to === 'paused') await this.t.runners.controlMissionTx(tx, ws, id, 'pause');
      if (m.state === 'paused' && to === 'active') await this.t.runners.unpauseMissionTx(tx, ws, id);
      await tx.commit(this.t.db);
    });
    return this.refresh(ws, id);
  }

  /** Cancel a mission and its open work. Linked issues are never closed because of a cancel. */
  async cancel(actor: Actor, id: string, reason: string): Promise<Mission> {
    requireScope(actor, 'missions:write');
    const ws = actor.principal.workspaceId;
    await this.t.retrying(async () => {
      const m = await this.t.repo.mission(ws, id);
      if (m.state === 'cancelled') return;
      assertMissionTransition(m.state, 'cancelled');
      const tx = this.t.uow(actor);
      tx.save('mission', SPECS.mission, { ...m, state: 'cancelled' as const, activity: 'idle' as const }, 'mission.cancelled', { missionId: id, payload: { reason } });
      await this.t.runners.controlMissionTx(tx, ws, id, 'cancel');
      for (const d of await this.t.repo.decisions(ws, { missionId: id, status: 'open' })) {
        tx.save('decision', SPECS.decision, { ...d, status: 'withdrawn' as const }, 'decision.withdrawn', { missionId: id, payload: { reason: 'mission cancelled' } });
      }
      await tx.commit(this.t.db);
    });
    return this.t.repo.mission(ws, id);
  }

  async addPacket(actor: Actor, missionId: string, input: NewPacketInput, idempotencyKey?: string): Promise<Packet> {
    requireScope(actor, 'missions:write');
    return this.t.idempotent(actor, idempotencyKey, { op: 'packet.add', missionId, input }, async () => {
      const ws = actor.principal.workspaceId;
      const m = await this.t.repo.mission(ws, missionId);
      if (['completed', 'cancelled'].includes(m.state)) fail('invalid_transition', `cannot add work to a ${m.state} mission`);
      const existing = await this.t.repo.packets(ws, missionId);
      for (const d of input.dependsOn ?? []) if (!existing.some((p) => p.id === d)) fail('invalid', `dependency ${d} is not a packet of this mission`);
      const outside = packetResources(input).filter((r) => !m.authority.resources.some((x) => envelopeCovers({ actions: ['*'], resources: [x] }, '*', r)));
      const tx = this.t.uow(actor);
      let mission = m;
      if (outside.length) {
        if (actor.principal.kind !== 'human') fail('policy_denied', `work outside the mission envelope needs an expansion decision: ${outside.join(', ')}`);
        mission = tx.save('mission', SPECS.mission, { ...m, authority: { ...m.authority, resources: dedupe([...m.authority.resources, ...outside]) } }, 'mission.authority_extended', {
          missionId,
          payload: { resources: outside, by: 'owner plan' },
        });
      }
      // New work reopens a mission that was waiting on verification.
      if (['verifying', 'needs_attention'].includes(mission.state)) {
        mission = tx.save('mission', SPECS.mission, { ...mission, state: 'active' as const, verification: null }, 'mission.reopened_for_work', { missionId });
      }
      const packet = tx.save('packet', SPECS.packet, this.buildPacket(mission, input, 'planned'), 'packet.created', { missionId, payload: { title: input.title, origin: 'planned' } });
      await tx.commit(this.t.db);
      await this.refresh(ws, missionId);
      return packet;
    });
  }

  /**
   * Explicit outcome verification. Required for high/critical missions and for any
   * mission without an integrated verification receipt. Runners cannot verify.
   */
  async verify(actor: Actor, id: string, input: { verdict: 'pass' | 'fail'; note?: string; evidenceIds?: string[] }): Promise<Mission> {
    requireScope(actor, 'missions:write');
    const ws = actor.principal.workspaceId;
    const m = await this.t.repo.mission(ws, id);
    if (m.state !== 'verifying') fail('invalid_transition', `mission is ${m.state}, not verifying`);
    let policy;
    if (actor.principal.kind !== 'human') {
      policy = await this.t.policy.evaluate(ws, { grantee: 'chief', action: 'mission.verify', resource: `mission:${id}`, risk: m.risk });
      if (!policy.allowed) fail('policy_denied', `verifying this mission needs the owner or a mission.verify grant: ${policy.reason}`, { policy });
    }
    if (input.verdict === 'pass') {
      const missing = await this.verificationGaps(ws, m);
      if (missing.length) fail('invalid', `cannot pass verification: ${missing.join('; ')}`, { missing });
    }
    const tx = this.t.uow(actor);
    const verification = {
      verdict: input.verdict,
      by: actor.principal.id,
      byKind: actor.principal.kind,
      evidenceIds: input.evidenceIds ?? [],
      ...(input.note ? { note: input.note } : {}),
      at: tx.now,
      independent: true,
    };
    const to: MissionState = input.verdict === 'pass' ? 'reconciling' : 'needs_attention';
    const discrepancies =
      input.verdict === 'fail'
        ? [...m.discrepancies, { id: this.t.id('dsc'), kind: 'missing_evidence' as const, detail: `verification failed: ${input.note ?? 'no note'}`, detectedAt: tx.now }]
        : m.discrepancies;
    tx.save('mission', SPECS.mission, { ...m, state: to, verification, discrepancies }, `mission.verification_${input.verdict}`, {
      missionId: id,
      payload: verification,
      ...(policy ? { policy } : {}),
    });
    await tx.commit(this.t.db);
    return this.refresh(ws, id);
  }

  /** What still stands between a verifying mission and a passing verdict. */
  async verificationGaps(ws: string, m: Mission): Promise<string[]> {
    const gaps: string[] = [];
    const packets = await this.t.repo.packets(ws, m.id);
    const children = await this.t.repo.children(ws, m.id);
    const wc = workComplete(packets, children);
    if (!wc.ok) gaps.push(...wc.missing);
    for (const p of packets) if (p.state === 'done' && !p.gate?.passed) gaps.push(`packet ${p.id} has no passing gate`);
    for (const d of m.dod) if (!d.done) gaps.push(`definition-of-done item "${d.text}" is not met`);
    if (RISK_ORDER[m.risk] >= RISK_ORDER.high) {
      const integrated = packets.some((p) => p.kind === 'integration' && p.state === 'done' && p.gate?.passed);
      if (!integrated && packets.length > 0) gaps.push('high-risk mission needs an independently reviewed integration result');
    }
    return gaps;
  }

  /**
   * Re-derive a mission's progress: release packets whose dependencies are met,
   * add an integration packet when several outputs must be verified together,
   * advance active -> verifying -> reconciling, and refresh the activity summary.
   */
  async refresh(ws: string, id: string): Promise<Mission> {
    const sys = this.t.systemActor(ws);
    const m = await this.t.retrying(() => this.refreshOnce(ws, id, sys));
    if (m.state === 'reconciling') await this.t.issues.reconcile(ws, id);
    const after = await this.t.repo.mission(ws, id);
    if (after.parentId && (after.state === 'completed' || after.state === 'cancelled' || after.state !== m.state)) {
      await this.refresh(ws, after.parentId);
    }
    return this.t.repo.mission(ws, id);
  }

  private async refreshOnce(ws: string, id: string, sys: Actor): Promise<Mission> {
    let m = await this.t.repo.mission(ws, id);
    const packets = await this.t.repo.packets(ws, id);
    const children = await this.t.repo.children(ws, id);
    const tx = this.t.uow(sys);
    const byId = new Map(packets.map((p) => [p.id, p]));
    const unmetMissionDeps: string[] = [];
    for (const dep of m.dependsOn) if ((await this.t.repo.mission(ws, dep)).state !== 'completed') unmetMissionDeps.push(dep);

    if (m.state === 'active') {
      if (unmetMissionDeps.length === 0) {
        for (const p of packets) {
          if (p.state === 'pending' && depsSatisfied(p, byId)) {
            const saved = tx.save('packet', SPECS.packet, { ...p, state: 'ready' as const }, 'packet.ready', { missionId: id });
            byId.set(p.id, saved);
          }
        }
      }
      const current = [...byId.values()];
      const wc = workComplete(current, children);
      const workPackets = current.filter((p) => p.kind === 'work' && p.state === 'done');
      const needsIntegration = wc.ok && !current.some((p) => p.kind === 'integration') && workPackets.length + children.length >= 2;
      if (needsIntegration) {
        const repos = dedupe(workPackets.map((p) => p.scope.repo).filter((r): r is string => Boolean(r)));
        const integ = this.buildPacket(
          m,
          {
            title: 'Verify the integrated result',
            goal: `Verify that the combined outputs achieve the mission outcome: ${m.outcome}`,
            kind: 'integration',
            scope: repos.length === 1 ? { repo: repos[0]! } : {},
            acceptance: m.acceptance,
            dependsOn: workPackets.map((p) => p.id),
            reviewRequired: RISK_ORDER[m.risk] >= RISK_ORDER.medium,
          },
          'planned',
        );
        tx.save('packet', SPECS.packet, { ...integ, state: 'ready' as const }, 'packet.created', { missionId: id, payload: { title: integ.title, origin: 'integration' } });
      } else if (wc.ok) {
        m = tx.save('mission', SPECS.mission, { ...m, state: 'verifying' as const }, 'mission.verifying', { missionId: id });
      }
    }

    if (m.state === 'verifying' && RISK_ORDER[m.risk] < RISK_ORDER.high) {
      const all = [...byId.values()];
      const finalPacket = all.find((p) => p.kind === 'integration') ?? (all.length === 1 ? all[0] : undefined);
      const integrated = finalPacket?.state === 'done' && finalPacket.gate?.passed && hasIntegratedPass(finalPacket.result);
      const gaps = integrated ? await this.verificationGaps(ws, m) : ['no integrated verification receipt'];
      if (gaps.length === 0) {
        const verification = { verdict: 'pass' as const, by: sys.principal.id, byKind: 'system' as const, evidenceIds: [], note: `integrated verification from packet ${finalPacket!.id}`, at: tx.now, independent: false };
        m = tx.save('mission', SPECS.mission, { ...m, state: 'reconciling' as const, verification }, 'mission.verification_pass', { missionId: id, payload: verification });
      }
    }

    const runners = await this.t.repo.runners(ws);
    const online = runners.filter((r) => r.status === 'online').length;
    const openChildren = children.filter((c) => !['completed', 'cancelled'].includes(c.state)).length;
    const { activity, blockers } = deriveActivity(m, [...byId.values()], { onlineRunnerCount: online, openChildMissions: openChildren, unmetMissionDeps });
    if (m.state === 'verifying' && RISK_ORDER[m.risk] >= RISK_ORDER.high) blockers.push({ kind: 'verification', reason: 'high-risk outcome needs explicit verification by the owner or a delegated verifier' });
    if (tx.stmts.length) await tx.commit(this.t.db);
    if (m.state !== 'reconciling' && (activity !== m.activity || JSON.stringify(blockers) !== JSON.stringify(m.blockers))) {
      // Activity is a derived explanation, not authoritative state: no version bump or event.
      await this.t.db.batch([{ sql: 'UPDATE missions SET activity = ?, blockers_json = ? WHERE id = ?', params: [activity, JSON.stringify(blockers), id] }]);
    }
    return this.t.repo.mission(ws, id);
  }
}

function hasIntegratedPass(result: unknown): boolean {
  const r = result as { integratedVerification?: { status?: string } } | null;
  return r?.integratedVerification?.status === 'pass';
}

export function dedupe<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
