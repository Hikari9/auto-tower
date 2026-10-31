import {
  DISPATCH_CONTRACT,
  EffectSchema,
  ExpansionSchema,
  FollowupSchema,
  HeartbeatSchema,
  ReceiptSchema,
  RegisterSchema,
  RUNNER_PROTOCOL,
  type Completion,
  type DispatchContract,
  type Receipt,
} from '../contracts/office-v1.ts';
import { backoffMs, ineligibility, selectCandidate, type Candidate } from '../domain/broker.ts';
import { fail, TowerError } from '../domain/errors.ts';
import { evaluateGate, isLandingAction, reviewProblems } from '../domain/gates.ts';
import { assertPacketTransition } from '../domain/lifecycle.ts';
import { envelopeCovers } from '../domain/policy.ts';
import { redact } from '../domain/redact.ts';
import type { Actor, Attempt, Checkpoint, FailureClass, Mission, Packet, PacketState, PolicyEvaluation, Runner } from '../domain/types.ts';
import { SPECS } from '../store/codec.ts';
import type { UnitOfWork } from '../store/uow.ts';
import { requireKind, requireScope } from './auth.ts';
import { packetResources } from './missions.ts';
import type { Tower } from './tower.ts';

export type Directive = { attemptId: string; action: 'continue' | 'stop' | 'cancel' | 'pause' | 'hold'; reason: string };

const LIVE: Attempt['state'][] = ['leased', 'running'];

export function movePacket(tx: UnitOfWork, p: Packet, to: PacketState, type: string, patch: Partial<Packet> = {}, payload: unknown = {}): Packet {
  if (p.state !== to) assertPacketTransition(p.state, to);
  return tx.save('packet', SPECS.packet, { ...p, ...patch, state: to }, type, { missionId: p.missionId, payload });
}

/**
 * Runner protocol (tower.runner/v1): registration, heartbeats, claims with
 * fencing, receipts, point-of-effect authorization, follow-ups and expansions.
 * Runners connect outbound and poll; Tower never needs an inbound port on a laptop.
 */
export class RunnerService {
  private readonly t: Tower;

  constructor(t: Tower) {
    this.t = t;
  }

  private async self(actor: Actor): Promise<Runner> {
    requireScope(actor, 'runner:protocol');
    requireKind(actor, 'runner');
    const r = await this.t.repo.runnerByPrincipal(actor.principal.id);
    return r ?? fail('not_found', 'runner is not registered; call register first');
  }

  async register(actor: Actor, raw: unknown) {
    requireScope(actor, 'runner:protocol');
    requireKind(actor, 'runner');
    const input = RegisterSchema.parse(raw);
    const ws = actor.principal.workspaceId;
    const runner = await this.t.retrying(async () => {
      const existing = await this.t.repo.runnerByPrincipal(actor.principal.id);
      const tx = this.t.uow(actor);
      const base: Runner = existing ?? {
        id: this.t.id('run'),
        workspaceId: ws,
        principalId: actor.principal.id,
        name: input.name,
        clientVersion: null,
        platform: null,
        engines: [],
        capabilities: [],
        allowedScopes: [],
        maxConcurrency: 1,
        status: 'offline',
        quarantineReason: null,
        lastSeenAt: null,
        version: 0,
        createdAt: tx.now,
      };
      const next: Runner = {
        ...base,
        name: input.name,
        clientVersion: input.clientVersion,
        platform: input.platform,
        engines: input.engines,
        capabilities: input.capabilities,
        allowedScopes: input.allowedScopes,
        maxConcurrency: input.maxConcurrency,
        status: base.status === 'quarantined' ? 'quarantined' : 'online',
        lastSeenAt: tx.now,
      };
      const saved = tx.save('runner', SPECS.runner, next, existing ? 'runner.reregistered' : 'runner.registered', {
        payload: { engines: input.engines, capabilities: input.capabilities, clientVersion: input.clientVersion, maxConcurrency: input.maxConcurrency },
      });
      await tx.commit(this.t.db);
      return saved;
    });
    await this.refreshWaitingMissions(ws);
    return { runner, protocol: RUNNER_PROTOCOL, leaseMs: this.t.config.leaseMs, heartbeatMs: Math.floor(this.t.config.leaseMs / 3) };
  }

  /**
   * Heartbeat renews leases and reconciles what the runner believes it holds
   * against Tower's record. A runner that reconnects after sleeping either
   * resumes its still-held attempt or is told to stop because it was fenced.
   */
  async heartbeat(actor: Actor, raw: unknown): Promise<{ status: Runner['status']; directives: Directive[]; leaseMs: number; serverTime: string }> {
    const input = HeartbeatSchema.parse(raw);
    const runner = await this.self(actor);
    const ws = runner.workspaceId;
    const now = this.t.now();
    const wasOffline = runner.status === 'offline';
    const status: Runner['status'] = runner.status === 'quarantined' ? 'quarantined' : input.draining ? 'draining' : 'online';
    // Liveness is not work proof, so it is a plain projection update rather than an event.
    await this.t.db.batch([{ sql: 'UPDATE runners SET last_seen_at = ?, status = ? WHERE id = ?', params: [now, status, runner.id] }]);
    const directives: Directive[] = [];
    for (const rep of input.attempts) {
      directives.push(await this.t.retrying(() => this.reconcileAttempt(actor, runner, status, rep.attemptId, rep.fence, rep.phase, rep.localRunId)));
    }
    if (wasOffline && status === 'online') await this.refreshWaitingMissions(ws);
    return { status, directives, leaseMs: this.t.config.leaseMs, serverTime: now };
  }

  private async reconcileAttempt(actor: Actor, runner: Runner, status: Runner['status'], attemptId: string, fence: number, phase?: string, localRunId?: string): Promise<Directive> {
    const ws = runner.workspaceId;
    let a: Attempt;
    try {
      a = await this.t.repo.attempt(ws, attemptId);
    } catch {
      return { attemptId, action: 'stop', reason: 'unknown attempt' };
    }
    if (a.runnerId !== runner.id) return { attemptId, action: 'stop', reason: 'attempt belongs to another runner' };
    if (status === 'quarantined') return { attemptId, action: 'stop', reason: 'runner is quarantined' };
    const lock = await this.t.repo.scopeLock(a.execScope);
    const holds = lock?.holderAttemptId === a.id && lock.fence === a.fence && a.fence === fence;
    if (!holds || a.state === 'fenced') return { attemptId, action: 'stop', reason: 'fenced: another attempt owns this execution scope' };
    if (a.state === 'cancelled' || a.control === 'cancel') return { attemptId, action: 'cancel', reason: 'cancelled by owner' };
    if (['succeeded', 'failed'].includes(a.state)) return { attemptId, action: 'stop', reason: `attempt already ${a.state}` };
    if (a.control === 'pause') return { attemptId, action: 'pause', reason: 'paused by owner' };

    const lease = this.t.later(this.t.config.leaseMs);
    const packet = await this.t.repo.packet(ws, a.packetId);
    if (a.state === 'lost') {
      // Same-run recovery: the original runner reconnected and still holds the fence.
      const tx = this.t.uow(actor);
      tx.save('attempt', SPECS.attempt, { ...a, state: 'running' as const, leaseExpiresAt: lease, ...(phase ? { phase } : {}), ...(localRunId ? { localRunId } : {}) }, 'attempt.recovered', {
        missionId: a.missionId,
      });
      if (packet.state === 'recovering') movePacket(tx, packet, 'running', 'packet.recovered', { holdReason: null }, { attemptId: a.id });
      await tx.commit(this.t.db);
      await this.t.missions.refresh(ws, a.missionId);
      return { attemptId, action: 'continue', reason: 'recovered: original run reconciled' };
    }
    await this.t.db.batch([{ sql: 'UPDATE attempts SET lease_expires_at = ? WHERE id = ? AND fence = ?', params: [lease, a.id, a.fence] }]);
    if (packet.state === 'held') return { attemptId, action: 'hold', reason: packet.holdReason ?? 'waiting for a decision' };
    return { attemptId, action: 'continue', reason: 'lease renewed' };
  }

  /** Claim the best eligible packet for this runner, or null. Exactly one holder per execution scope. */
  async claim(actor: Actor): Promise<{ attempt: Attempt; contract: DispatchContract } | null> {
    const runner = await this.self(actor);
    const ws = runner.workspaceId;
    const workspace = await this.t.repo.workspace(ws);
    if (workspace.halted) return null;
    if (runner.status !== 'online') return null;
    const live = await this.t.repo.attemptsFor(ws, { runnerId: runner.id, states: LIVE });
    if (live.length >= runner.maxConcurrency) return null;
    for (let i = 0; i < 4; i++) {
      try {
        return await this.claimOnce(actor, runner);
      } catch (err) {
        if (!(err instanceof TowerError && err.code === 'conflict')) throw err;
      }
    }
    return null;
  }

  private async claimOnce(actor: Actor, runner: Runner): Promise<{ attempt: Attempt; contract: DispatchContract } | null> {
    const ws = runner.workspaceId;
    const now = this.t.now();
    const ready = (await this.t.repo.packetsByState(ws, ['ready'])).filter((p) => !p.nextEligibleAt || p.nextEligibleAt <= now);
    if (!ready.length) return null;
    const missions = new Map<string, Mission>();
    const candidates: Candidate[] = [];
    const busy = new Set<string>();
    for (const p of ready) {
      const m = missions.get(p.missionId) ?? (await this.t.repo.mission(ws, p.missionId));
      missions.set(m.id, m);
      if (m.state !== 'active') continue;
      const lock = await this.t.repo.scopeLock(p.execScope);
      if (lock?.holderAttemptId) {
        const holder = await this.t.repo.attempt(ws, lock.holderAttemptId);
        // A lost holder may be superseded only by its own packet, which is ready again
        // because it has a portable checkpoint or the owner approved a restart.
        const superseded = holder.state === 'fenced' || holder.state === 'cancelled' || (holder.state === 'lost' && holder.packetId === p.id);
        if (!superseded) busy.add(p.execScope);
      }
      const prev = p.currentAttemptId ? await this.t.repo.attempt(ws, p.currentAttemptId) : undefined;
      candidates.push({ packet: p, mission: m, ...(prev ? { previousRunnerId: prev.runnerId } : {}) });
    }
    const pick = selectCandidate(runner, candidates, busy);
    if (!pick) return null;
    const { packet, mission } = pick;

    const tx = this.t.uow(actor);
    const lock = await this.t.repo.scopeLock(packet.execScope);
    const fence = (lock?.fence ?? 0) + 1;
    const scopeVersion = tx.event({ stream: 'scope', id: packet.execScope, expected: lock?.version ?? 0, type: 'scope.acquired', missionId: mission.id, payload: { fence, packetId: packet.id } });
    if (lock?.holderAttemptId) {
      const old = await this.t.repo.attempt(ws, lock.holderAttemptId);
      if (!['fenced', 'cancelled'].includes(old.state)) {
        tx.save('attempt', SPECS.attempt, { ...old, state: 'fenced' as const, control: null }, 'attempt.fenced', { missionId: old.missionId, payload: { by: fence } });
      }
    }
    const attemptId = this.t.id('att');
    tx.run(
      `INSERT INTO scope_locks (exec_scope, workspace_id, holder_attempt_id, fence, version, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(exec_scope) DO UPDATE SET holder_attempt_id = excluded.holder_attempt_id, fence = excluded.fence, version = excluded.version, updated_at = excluded.updated_at`,
      packet.execScope,
      ws,
      attemptId,
      fence,
      scopeVersion,
      tx.now,
    );
    const leaseExpiresAt = this.t.later(this.t.config.leaseMs);
    const contract = await this.buildContract(mission, packet, attemptId, fence, leaseExpiresAt, actor.correlationId);
    const attempt: Attempt = {
      id: attemptId,
      workspaceId: ws,
      packetId: packet.id,
      missionId: mission.id,
      runnerId: runner.id,
      execScope: packet.execScope,
      fence,
      leaseExpiresAt,
      state: 'leased',
      contract,
      localRunId: null,
      phase: null,
      checkpoint: packet.checkpoint,
      receipt: null,
      failureClass: null,
      failureDetail: null,
      control: null,
      version: 0,
      createdAt: tx.now,
      updatedAt: tx.now,
    };
    const saved = tx.save('attempt', SPECS.attempt, attempt, 'attempt.leased', { missionId: mission.id, payload: { runnerId: runner.id, fence, packetId: packet.id } });
    movePacket(tx, packet, 'leased', 'packet.leased', { currentAttemptId: attemptId, attemptsCount: packet.attemptsCount + 1, holdReason: null }, { attemptId, runnerId: runner.id });
    await tx.commit(this.t.db);
    await this.t.missions.refresh(ws, mission.id);
    return { attempt: saved, contract };
  }

  private async buildContract(m: Mission, p: Packet, attemptId: string, fence: number, leaseExpiresAt: string, correlationId: string): Promise<DispatchContract> {
    const ws = await this.t.repo.workspace(m.workspaceId);
    const links = await this.t.repo.links(m.workspaceId, m.id);
    const siblings = await this.t.repo.packets(m.workspaceId, m.id);
    return {
      contract: DISPATCH_CONTRACT,
      issuedAt: this.t.now(),
      attemptId,
      fence,
      leaseExpiresAt,
      correlationId,
      workspaceId: m.workspaceId,
      mission: { id: m.id, title: m.title, outcome: m.outcome, constraints: m.constraints, acceptance: m.acceptance, risk: m.risk, definitionOfDone: m.dod.map((d) => d.text) },
      packet: { id: p.id, title: p.title, goal: p.goal, kind: p.kind, scope: { ...p.scope }, acceptance: p.acceptance, engine: p.engine, risk: p.risk },
      links: links.map((l) => ({ url: l.url, role: l.role, title: l.titleSnapshot })),
      authority: { actions: m.authority.actions, resources: m.authority.resources, policyVersion: ws.policyVersion },
      guards: { pointOfEffectCheck: true, singleWriterScope: p.execScope, leaseRenewal: 'heartbeat', landingRequiresGate: p.reviewRequired },
      evidenceProfile: {
        selfVerification: true,
        independentReview: p.reviewRequired,
        integratedVerification: p.kind === 'integration' || siblings.length === 1,
        commitSha: Boolean(p.scope.repo),
      },
      resumeFrom: p.checkpoint?.portable ? { kind: p.checkpoint.kind, ...(p.checkpoint.ref ? { ref: p.checkpoint.ref } : {}), ...(p.checkpoint.sha ? { sha: p.checkpoint.sha } : {}) } : null,
      untrustedFields: ['mission.title', 'mission.outcome', 'packet.goal', 'links[].title'],
    };
  }

  /** Load an attempt the calling runner currently and exclusively holds, or fail as fenced. */
  private async held(runner: Runner, attemptId: string, fence: number): Promise<Attempt> {
    const a = await this.t.repo.attempt(runner.workspaceId, attemptId);
    if (a.runnerId !== runner.id) fail('forbidden', 'attempt belongs to another runner');
    const lock = await this.t.repo.scopeLock(a.execScope);
    if (a.fence !== fence || lock?.holderAttemptId !== a.id || lock.fence !== a.fence || ['fenced', 'cancelled'].includes(a.state)) {
      fail('fenced', 'stale fence: this attempt no longer owns its execution scope', { attemptId, fence, currentFence: lock?.fence ?? null });
    }
    return a;
  }

  /** Accept a receipt. Duplicates (same receiptId) are no-ops; stale fences are rejected and audited. */
  async report(actor: Actor, raw: unknown) {
    const runner = await this.self(actor);
    const parsed = ReceiptSchema.parse(raw);
    const { value: receipt, count: redactions } = redact(parsed);
    return this.t.idempotent(actor, `receipt:${receipt.receiptId}`, receipt, async () => {
      try {
        return await this.t.retrying(() => this.applyReceipt(actor, runner, receipt, redactions));
      } catch (err) {
        if (err instanceof TowerError && err.code === 'fenced') {
          await this.t.db.batch([
            {
              sql: `INSERT INTO events (id, workspace_id, stream_type, stream_id, stream_version, type, actor_id, actor_kind, correlation_id, mission_id, payload_json, created_at)
                    VALUES (?, ?, 'audit', ?, 1, 'receipt.rejected_fenced', ?, 'runner', ?, NULL, ?, ?)`,
              params: [this.t.id('evt'), runner.workspaceId, this.t.id('aud'), actor.principal.id, actor.correlationId, JSON.stringify({ attemptId: receipt.attemptId, fence: receipt.fence, kind: receipt.kind }), this.t.now()],
            },
          ]);
        }
        throw err;
      }
    });
  }

  private async applyReceipt(actor: Actor, runner: Runner, r: Receipt, redactions: number) {
    const ws = runner.workspaceId;
    let a = await this.held(runner, r.attemptId, r.fence);
    if (['succeeded', 'failed'].includes(a.state)) fail('conflict', `attempt already ${a.state}`);
    const packet = await this.t.repo.packet(ws, a.packetId);
    const tx = this.t.uow(actor);
    const meta = { receiptId: r.receiptId, redactions };
    const lease = this.t.later(this.t.config.leaseMs);

    if (r.kind === 'progress' || r.kind === 'checkpoint') {
      const checkpoint: Checkpoint | null = r.checkpoint ? { ...r.checkpoint, at: tx.now } : a.checkpoint;
      a = tx.save(
        'attempt',
        SPECS.attempt,
        { ...a, state: 'running' as const, phase: r.phase ?? a.phase, localRunId: r.localRunId ?? a.localRunId, checkpoint, leaseExpiresAt: lease },
        r.kind === 'checkpoint' ? 'attempt.checkpoint' : 'attempt.progress',
        { missionId: a.missionId, payload: { ...meta, phase: r.phase, message: r.message, checkpoint: r.checkpoint } },
      );
      // A progress receipt from a lost-but-unfenced attempt is also a same-run recovery.
      if (packet.state === 'leased' || packet.state === 'recovering') movePacket(tx, packet, 'running', 'packet.running', { holdReason: null, ...(r.checkpoint ? { checkpoint } : {}) });
      else if (r.checkpoint) tx.save('packet', SPECS.packet, { ...packet, checkpoint }, 'packet.checkpointed', { missionId: a.missionId, payload: r.checkpoint });
      await tx.commit(this.t.db);
      if (packet.state === 'leased' || packet.state === 'recovering') await this.t.missions.refresh(ws, a.missionId);
      return { ok: true, attemptState: a.state };
    }

    this.releaseScopeTx(tx, a, await this.t.repo.scopeLock(a.execScope));
    if (r.kind === 'complete') {
      const c = r.completion ?? fail('invalid', 'complete receipts need a completion');
      if (c.outcome === 'failed') return this.applyFailure(tx, a, packet, 'implementation_defect', c.selfVerification.summary || 'executor reported failure', true, meta, c);
      const gate = evaluateGate(packet, c, tx.now);
      tx.save('attempt', SPECS.attempt, { ...a, state: 'succeeded' as const, receipt: c, phase: 'done' }, 'attempt.succeeded', {
        missionId: a.missionId,
        payload: { ...meta, gate, commitSha: c.commitSha ?? null },
      });
      const evidenceIds = this.recordEvidenceTx(tx, a, c, gate.passed);
      if (gate.passed) {
        movePacket(tx, packet, 'done', 'packet.done', { result: c, gate, ...(c.commitSha ? { checkpoint: { portable: true, kind: 'branch' as const, sha: c.commitSha, at: tx.now } } : {}) }, { gate });
        if (c.dodItemsMet.length) {
          const m = await this.t.repo.mission(ws, a.missionId);
          const dod = m.dod.map((d) => (c.dodItemsMet.includes(d.id) && !d.done ? { ...d, done: true, evidenceId: evidenceIds[0]! } : d));
          tx.save('mission', SPECS.mission, { ...m, dod }, 'mission.dod_met', { missionId: m.id, payload: { items: c.dodItemsMet, evidenceId: evidenceIds[0] } });
        }
        await tx.commit(this.t.db);
        await this.t.missions.refresh(ws, a.missionId);
        return { ok: true, gate };
      }
      // Gate failures are review failures: retry while attempts remain, otherwise wait for the owner.
      return this.applyFailure(tx, a, packet, 'review_failure', gate.reasons.join('; '), true, meta, c, gate);
    }

    const f = r.failure ?? fail('invalid', 'fail receipts need a failure');
    return this.applyFailure(tx, a, packet, f.class, f.detail, f.retryable, meta);
  }

  private async applyFailure(
    tx: UnitOfWork,
    a: Attempt,
    packet: Packet,
    cls: FailureClass,
    detail: string,
    retryable: boolean,
    meta: Record<string, unknown>,
    completion?: unknown,
    gate?: Packet['gate'],
  ) {
    if (gate === undefined || cls !== 'review_failure') {
      tx.save('attempt', SPECS.attempt, { ...a, state: 'failed' as const, failureClass: cls, failureDetail: detail, receipt: completion ?? a.receipt }, 'attempt.failed', {
        missionId: a.missionId,
        payload: { ...meta, class: cls, detail },
      });
    }
    const canRetry = retryable && cls !== 'policy_denial' && packet.attemptsCount < packet.maxAttempts;
    if (packet.state === 'paused' || packet.state === 'cancelled') {
      // Owner already stopped this branch; keep it where it is.
    } else if (cls === 'cancelled') {
      movePacket(tx, packet, 'paused', 'packet.paused', {}, { class: cls });
    } else if (canRetry) {
      const wait = backoffMs(packet.attemptsCount) * (cls === 'quota' ? 4 : 1);
      movePacket(tx, packet, 'ready', 'packet.retry_scheduled', { nextEligibleAt: this.t.later(wait), ...(gate ? { gate } : {}) }, { class: cls, detail, retryInMs: wait });
    } else {
      movePacket(tx, packet, cls === 'review_failure' ? 'review_pending' : 'failed', 'packet.failed', gate ? { gate } : {}, { class: cls, detail });
    }
    await tx.commit(this.t.db);
    await this.t.missions.refresh(a.workspaceId, a.missionId);
    return { ok: true, failureClass: cls, retrying: canRetry, ...(gate ? { gate } : {}) };
  }

  private recordEvidenceTx(tx: UnitOfWork, a: Attempt, c: Completion, verified: boolean): string[] {
    const ids: string[] = [];
    const add = (kind: string, summary: string, uri?: string, sha?: string, data: unknown = {}) => {
      const id = this.t.id('evd');
      ids.push(id);
      tx.run(
        `INSERT INTO evidence (id, workspace_id, mission_id, packet_id, attempt_id, kind, summary, uri, sha, verified, source, data_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        a.workspaceId,
        a.missionId,
        a.packetId,
        a.id,
        kind,
        summary,
        uri ?? null,
        sha ?? null,
        verified ? 1 : 0,
        `runner:${a.runnerId}`,
        JSON.stringify(data),
        tx.now,
      );
    };
    add('receipt', `${c.producer.engine} run ${c.producer.runId}: ${c.outcome}`, undefined, c.commitSha, {
      selfVerification: c.selfVerification,
      independentReview: c.independentReview ?? null,
      tests: c.tests ?? null,
      integratedVerification: c.integratedVerification ?? null,
      landing: c.landing ?? null,
      residualRisks: c.residualRisks,
    });
    for (const e of c.evidence) add(e.kind, e.summary, e.uri, e.sha);
    return ids;
  }

  private releaseScopeTx(tx: UnitOfWork, a: Attempt, lock: { holderAttemptId: string | null; fence: number; version: number } | undefined): void {
    if (!lock || lock.holderAttemptId !== a.id) return;
    const v = tx.event({ stream: 'scope', id: a.execScope, expected: lock.version, type: 'scope.released', missionId: a.missionId, payload: { attemptId: a.id, fence: a.fence } });
    tx.run('UPDATE scope_locks SET holder_attempt_id = NULL, version = ?, updated_at = ? WHERE exec_scope = ?', v, tx.now, a.execScope);
  }

  /**
   * Point-of-effect authorization. Uses the latest committed policy, so a grant
   * revoked mid-run blocks the next guarded effect. Landing actions also need the
   * independent review gate when the packet requires review.
   */
  async authorizeEffect(actor: Actor, raw: unknown): Promise<PolicyEvaluation> {
    const runner = await this.self(actor);
    const input = EffectSchema.parse(raw);
    const ws = runner.workspaceId;
    const a = await this.held(runner, input.attemptId, input.fence);
    const m = await this.t.repo.mission(ws, a.missionId);
    const packet = await this.t.repo.packet(ws, a.packetId);
    const risk = input.risk ?? packet.risk;
    let ev: PolicyEvaluation;
    if (m.state !== 'active' || ['paused', 'cancelled'].includes(packet.state) || a.control) {
      const ws0 = await this.t.repo.workspace(ws);
      ev = { allowed: false, basis: 'default_deny', policyVersion: ws0.policyVersion, reason: `mission is ${m.state} and packet is ${packet.state}; only non-privileged cleanup may continue` };
    } else {
      ev = await this.t.policy.evaluate(ws, { grantee: 'runner', action: input.action, resource: input.resource, risk, missionId: m.id }, { authority: m.authority, risk: m.risk });
      if (ev.allowed && isLandingAction(input.action) && (packet.reviewRequired || ['high', 'critical'].includes(packet.risk))) {
        const problems = reviewProblems(input.review, input.producerSessionId ?? '', input.review?.sha);
        if (!input.producerSessionId) problems.push('landing requests must name the producing session');
        if (problems.length) ev = { ...ev, allowed: false, basis: 'default_deny', reason: `landing blocked: ${problems.join('; ')}` };
      }
    }
    const tx = this.t.uow(actor);
    tx.save('attempt', SPECS.attempt, a, ev.allowed ? 'effect.authorized' : 'effect.denied', {
      missionId: a.missionId,
      policy: ev,
      payload: { action: input.action, resource: input.resource, risk, review: input.review ?? null },
    });
    if (ev.allowed && ev.basis === 'rule' && ev.ruleId) this.t.policy.recordUseTx(tx, await this.t.repo.rule(ws, ev.ruleId), { attemptId: a.id, action: input.action });
    await tx.commit(this.t.db);
    if (!ev.allowed) throw new TowerError('policy_denied', ev.reason, { evaluation: ev });
    return ev;
  }

  /** In-goal follow-up work: created without asking anyone when it stays inside the envelope. */
  async createFollowup(actor: Actor, raw: unknown): Promise<Packet> {
    const runner = await this.self(actor);
    const input = FollowupSchema.parse(raw);
    const ws = runner.workspaceId;
    return this.t.retrying(async () => {
      const a = await this.held(runner, input.attemptId, input.fence);
      const m = await this.t.repo.mission(ws, a.missionId);
      if (m.state !== 'active') fail('invalid_transition', `mission is ${m.state}`);
      const outside = packetResources(input).filter((r) => !envelopeCovers({ actions: ['*'], resources: m.authority.resources }, '*', r));
      if (outside.length) fail('policy_denied', `follow-up is outside the mission envelope (${outside.join(', ')}); request an expansion instead`);
      const tx = this.t.uow(actor);
      const p = this.t.missions.buildPacket(
        m,
        { title: input.title, goal: input.goal, ...(input.scope ? { scope: input.scope } : {}), ...(input.acceptance ? { acceptance: input.acceptance } : {}), dependsOn: input.dependsOnCurrent ? [a.packetId] : [] },
        'followup',
      );
      const saved = tx.save('packet', SPECS.packet, p, 'packet.created', { missionId: m.id, payload: { title: p.title, origin: 'followup', fromAttempt: a.id } });
      await tx.commit(this.t.db);
      await this.t.missions.refresh(ws, m.id);
      return saved;
    });
  }

  /**
   * Scope expansion (tier 2/3). Inside the envelope it is simply in scope. A runner
   * standing rule approves it directly. Otherwise it becomes a decision for the
   * Chief of Staff (only when a delegated rule could cover it) or the human inbox.
   * Only the requesting branch waits.
   */
  async requestExpansion(actor: Actor, raw: unknown) {
    const runner = await this.self(actor);
    const input = ExpansionSchema.parse(raw);
    const ws = runner.workspaceId;
    return this.t.retrying(async () => {
      const a = await this.held(runner, input.attemptId, input.fence);
      const m = await this.t.repo.mission(ws, a.missionId);
      const packet = await this.t.repo.packet(ws, a.packetId);
      const risk = input.risk ?? packet.risk;
      const req = { action: input.action, resource: input.resource, risk, missionId: m.id };
      const asRunner = await this.t.policy.evaluate(ws, { grantee: 'runner', ...req }, { authority: m.authority, risk: m.risk });
      const tx = this.t.uow(actor);
      const followup = input.followup ? { title: input.followup.title, goal: input.followup.goal, ...(input.followup.scope ? { scope: input.followup.scope } : {}) } : undefined;
      if (asRunner.allowed) {
        if (followup) {
          const p = this.t.missions.buildPacket(m, followup, asRunner.basis === 'envelope' ? 'followup' : 'expansion');
          tx.save('packet', SPECS.packet, p, 'packet.created', { missionId: m.id, policy: asRunner, payload: { title: p.title, origin: p.origin } });
        }
        tx.save('attempt', SPECS.attempt, a, 'expansion.in_scope', { missionId: m.id, policy: asRunner, payload: req });
        await tx.commit(this.t.db);
        await this.t.missions.refresh(ws, m.id);
        return { status: asRunner.basis === 'envelope' ? ('in_scope' as const) : ('approved_by_rule' as const), policy: asRunner };
      }
      if (asRunner.basis === 'deny_rule' || asRunner.basis === 'halted') {
        tx.save('attempt', SPECS.attempt, a, 'expansion.denied', { missionId: m.id, policy: asRunner, payload: req });
        await tx.commit(this.t.db);
        return { status: 'denied' as const, policy: asRunner };
      }
      const asChief = await this.t.policy.evaluate(ws, { grantee: 'chief', ...req });
      const audience = asChief.allowed && asChief.basis === 'rule' ? ('chief' as const) : ('human' as const);
      const d = await this.t.decisions.raiseTx(tx, {
        missionId: m.id,
        packetIds: input.blocking ? [packet.id] : [],
        category: 'expansion',
        urgency: 'normal',
        audience,
        question: `Allow ${input.action} on ${input.resource} for "${m.title}"?`,
        ...(input.alternatives ? { alternatives: input.alternatives } : {}),
        ...(input.recommendation ? { recommendation: { alternativeId: 'approve', rationale: input.recommendation, by: actor.principal.id } } : {}),
        consequences: input.reason,
        requiredAuthority: { action: input.action, resource: input.resource, risk },
        affectedScope: packet.execScope,
        onApprove: { extendAuthority: { actions: [input.action], resources: [input.resource] }, ...(followup ? { createPacket: followup } : {}) },
      });
      if (input.blocking) this.t.decisions.holdPacketsTx(tx, [packet], d.id, `waiting for ${audience === 'chief' ? 'Chief of Staff' : 'owner'}: ${input.action} on ${input.resource}`);
      await tx.commit(this.t.db);
      await this.t.missions.refresh(ws, m.id);
      return { status: 'pending' as const, decisionId: d.id, audience, policy: asRunner };
    });
  }

  // ---------- operator controls ----------

  async list(actor: Actor) {
    requireScope(actor, 'runners:read');
    const ws = actor.principal.workspaceId;
    const runners = await this.t.repo.runners(ws);
    const live = await this.t.repo.attemptsFor(ws, { states: ['leased', 'running', 'lost'] });
    return runners.map((r) => ({ ...r, attempts: live.filter((a) => a.runnerId === r.id).map((a) => ({ id: a.id, packetId: a.packetId, missionId: a.missionId, state: a.state, phase: a.phase, leaseExpiresAt: a.leaseExpiresAt })) }));
  }

  /** Quarantine fences every attempt the runner holds; its receipts are rejected from now on. */
  async quarantine(actor: Actor, runnerId: string, reason: string): Promise<Runner> {
    requireScope(actor, 'runners:admin');
    const ws = actor.principal.workspaceId;
    await this.t.retrying(async () => {
      const r = await this.t.repo.runner(ws, runnerId);
      const tx = this.t.uow(actor);
      tx.save('runner', SPECS.runner, { ...r, status: 'quarantined' as const, quarantineReason: reason }, 'runner.quarantined', { payload: { reason } });
      for (const a of await this.t.repo.attemptsFor(ws, { runnerId, states: ['leased', 'running', 'lost'] })) {
        tx.save('attempt', SPECS.attempt, { ...a, state: 'fenced' as const }, 'attempt.fenced', { missionId: a.missionId, payload: { reason: 'runner quarantined' } });
        const p = await this.t.repo.packet(ws, a.packetId);
        if (['leased', 'running', 'recovering'].includes(p.state)) {
          // Local work on an untrusted machine is discarded; restart from the last portable checkpoint, if any.
          const checkpoint = a.checkpoint?.portable ? a.checkpoint : p.checkpoint?.portable ? p.checkpoint : null;
          movePacket(tx, p, 'ready', 'packet.requeued', { checkpoint }, { reason: 'runner quarantined', resumeFrom: checkpoint });
        }
      }
      await tx.commit(this.t.db);
    });
    return this.t.repo.runner(ws, runnerId);
  }

  async release(actor: Actor, runnerId: string): Promise<Runner> {
    requireScope(actor, 'runners:admin');
    const ws = actor.principal.workspaceId;
    const r = await this.t.repo.runner(ws, runnerId);
    if (r.status !== 'quarantined') return r;
    const tx = this.t.uow(actor);
    const saved = tx.save('runner', SPECS.runner, { ...r, status: 'offline' as const, quarantineReason: null }, 'runner.released');
    await tx.commit(this.t.db);
    return saved;
  }

  async packetControl(actor: Actor, packetId: string, action: 'pause' | 'resume' | 'cancel' | 'retry'): Promise<Packet> {
    requireScope(actor, 'missions:write');
    const ws = actor.principal.workspaceId;
    await this.t.retrying(async () => {
      const p = await this.t.repo.packet(ws, packetId);
      const tx = this.t.uow(actor);
      if (action === 'retry') {
        if (!['failed', 'review_pending'].includes(p.state)) fail('invalid_transition', `cannot retry a ${p.state} packet`);
        movePacket(tx, p, 'ready', 'packet.retry_requested', { maxAttempts: p.attemptsCount + 1, nextEligibleAt: null });
      } else if (action === 'resume') {
        if (p.state !== 'paused') fail('invalid_transition', `packet is ${p.state}`);
        movePacket(tx, p, 'pending', 'packet.resumed');
      } else await this.controlPacketTx(tx, p, action);
      await tx.commit(this.t.db);
    });
    const p = await this.t.repo.packet(ws, packetId);
    await this.t.missions.refresh(ws, p.missionId);
    return this.t.repo.packet(ws, packetId);
  }

  private async controlPacketTx(tx: UnitOfWork, p: Packet, action: 'pause' | 'cancel'): Promise<void> {
    if (['done', 'cancelled'].includes(p.state) || (action === 'pause' && p.state === 'paused')) return;
    const a = p.currentAttemptId ? await this.t.repo.attempt(p.workspaceId, p.currentAttemptId) : null;
    if (a && ['leased', 'running', 'lost'].includes(a.state)) {
      if (action === 'cancel') {
        tx.save('attempt', SPECS.attempt, { ...a, state: 'cancelled' as const, control: 'cancel' as const }, 'attempt.cancelled', { missionId: a.missionId });
        this.releaseScopeTx(tx, a, await this.t.repo.scopeLock(a.execScope));
      } else {
        tx.save('attempt', SPECS.attempt, { ...a, control: 'pause' as const }, 'attempt.pause_requested', { missionId: a.missionId });
      }
    }
    movePacket(tx, p, action === 'cancel' ? 'cancelled' : 'paused', action === 'cancel' ? 'packet.cancelled' : 'packet.paused');
  }

  async controlMissionTx(tx: UnitOfWork, ws: string, missionId: string, action: 'pause' | 'cancel'): Promise<void> {
    for (const p of await this.t.repo.packets(ws, missionId)) await this.controlPacketTx(tx, p, action);
  }

  async unpauseMissionTx(tx: UnitOfWork, ws: string, missionId: string): Promise<void> {
    for (const p of await this.t.repo.packets(ws, missionId)) {
      if (p.state !== 'paused') continue;
      const a = p.currentAttemptId ? await this.t.repo.attempt(ws, p.currentAttemptId) : null;
      if (a?.control === 'pause' && ['leased', 'running'].includes(a.state)) {
        tx.save('attempt', SPECS.attempt, { ...a, control: null }, 'attempt.unpaused', { missionId });
        movePacket(tx, p, 'recovering', 'packet.resumed', { holdReason: 'waiting for the runner to resume' });
      } else movePacket(tx, p, 'pending', 'packet.resumed');
    }
  }

  /** Preview who could take a mission's ready work, and why others cannot. */
  async previewDispatch(actor: Actor, missionId: string) {
    requireScope(actor, 'missions:read');
    const ws = actor.principal.workspaceId;
    const m = await this.t.repo.mission(ws, missionId);
    const packets = await this.t.repo.packets(ws, missionId);
    const runners = await this.t.repo.runners(ws);
    const held = await this.t.repo.heldScopes(ws);
    const workspace = await this.t.repo.workspace(ws);
    return {
      mission: { id: m.id, state: m.state, activity: m.activity },
      halted: workspace.halted,
      packets: packets
        .filter((p) => !['done', 'cancelled'].includes(p.state))
        .map((p) => ({
          id: p.id,
          title: p.title,
          state: p.state,
          scopeBusy: held.has(p.execScope),
          nextEligibleAt: p.nextEligibleAt,
          runners: runners.map((r) => ({ id: r.id, name: r.name, eligible: ineligibility(r, p) === null, reason: ineligibility(r, p) })),
        })),
      note: 'Dispatch is automatic: eligible online runners claim ready work on their next poll.',
    };
  }

  /** Make missions that were waiting for a runner re-explain themselves once one appears. */
  private async refreshWaitingMissions(ws: string): Promise<void> {
    for (const m of await this.t.repo.missions(ws, { states: ['active'] })) {
      if (m.activity === 'waiting_runner') await this.t.missions.refresh(ws, m.id);
    }
  }
}
