import { fail } from '../domain/errors.ts';
import { approvalPatternKey, evaluatePolicy, matchPattern, ruleLive } from '../domain/policy.ts';
import { RISK_ORDER } from '../domain/types.ts';
import type { Actor, AuthorityEnvelope, Decision, Grantee, PolicyEvaluation, PolicyRequest, PolicyRule, Risk, RuleConditions } from '../domain/types.ts';
import { SPECS } from '../store/codec.ts';
import type { Proposal } from '../store/repo.ts';
import type { UnitOfWork } from '../store/uow.ts';
import { requireScope } from './auth.ts';
import type { Tower } from './tower.ts';

export interface GrantInput {
  effect?: 'allow' | 'deny';
  action: string;
  resource: string;
  grantee?: Grantee;
  conditions?: RuleConditions;
  expiresAt?: string | null;
  note?: string;
}

const PROPOSAL_SPEC = { table: 'rule_proposals', json: ['proposed', 'evidence'] } as const;

export class PolicyService {
  private readonly t: Tower;

  constructor(t: Tower) {
    this.t = t;
  }

  /**
   * Evaluate against the latest committed policy. Never cached: every guarded
   * effect calls this at the point of effect, so a revoke applies to the next effect.
   */
  async evaluate(ws: string, req: PolicyRequest, envelope?: { authority: AuthorityEnvelope; risk: Risk }): Promise<PolicyEvaluation> {
    const [workspace, rules] = await Promise.all([this.t.repo.workspace(ws), this.t.repo.rules(ws)]);
    return evaluatePolicy(req, { rules, policyVersion: workspace.policyVersion, now: this.t.now(), halted: workspace.halted, ...(envelope ? { envelope } : {}) });
  }

  /** Count one use of a rule that just authorized an effect (enforces maxUses). */
  recordUseTx(tx: UnitOfWork, rule: PolicyRule, context: Record<string, unknown>): void {
    tx.save('rule', SPECS.rule, { ...rule, uses: rule.uses + 1 }, 'rule.used', { payload: context });
  }

  async list(actor: Actor, includeRevoked = true) {
    requireScope(actor, 'policy:read');
    const ws = actor.principal.workspaceId;
    const [workspace, rules, proposals, preferences] = await Promise.all([
      this.t.repo.workspace(ws),
      this.t.repo.rules(ws, includeRevoked),
      this.t.repo.proposals(ws),
      this.t.repo.preferences(ws),
    ]);
    const now = this.t.now();
    return {
      policyVersion: workspace.policyVersion,
      halted: workspace.halted,
      rules: rules.map((r) => ({ ...r, effective: ruleLive(r, now) })),
      proposals,
      preferences,
    };
  }

  /** Explicit human grant (or deny). Bumps the workspace policy version. */
  async grant(actor: Actor, input: GrantInput, idempotencyKey?: string): Promise<PolicyRule> {
    requireScope(actor, 'policy:grant');
    return this.t.idempotent(actor, idempotencyKey, { op: 'policy.grant', input }, () =>
      this.t.retrying(async () => {
        const tx = this.t.uow(actor);
        const rule = await this.createRuleTx(tx, input, 'explicit', null);
        await tx.commit(this.t.db);
        return rule;
      }),
    );
  }

  private async createRuleTx(tx: UnitOfWork, input: GrantInput, source: PolicyRule['source'], supersedes: string | null): Promise<PolicyRule> {
    if (!input.action?.trim() || !input.resource?.trim()) fail('invalid', 'action and resource are required');
    if (input.conditions?.maxRisk && !(input.conditions.maxRisk in RISK_ORDER)) fail('invalid', 'invalid maxRisk');
    const ws = tx.workspaceId;
    const policyVersion = await this.bumpPolicyVersionTx(tx, 'policy.rule_granted', { action: input.action, resource: input.resource });
    const rule: PolicyRule = {
      id: this.t.id('rule'),
      workspaceId: ws,
      effect: input.effect ?? 'allow',
      action: input.action.trim(),
      resource: input.resource.trim(),
      grantee: input.grantee ?? 'chief',
      conditions: input.conditions ?? {},
      status: 'active',
      expiresAt: input.expiresAt ?? null,
      uses: 0,
      supersedes,
      source,
      createdBy: tx.actor.principal.id,
      createdAt: tx.now,
      createdPolicyVersion: policyVersion,
      revokedBy: null,
      revokedAt: null,
      note: input.note ?? '',
      version: 0,
    };
    return tx.save('rule', SPECS.rule, rule, 'rule.granted', { payload: { ...rule, version: undefined } });
  }

  private async bumpPolicyVersionTx(tx: UnitOfWork, type: string, payload: unknown): Promise<number> {
    const ws = await this.t.repo.workspace(tx.workspaceId);
    const version = tx.event({ stream: 'workspace', id: ws.id, expected: ws.version, type, payload });
    tx.run('UPDATE workspaces SET policy_version = ?, version = ? WHERE id = ?', ws.policyVersion + 1, version, ws.id);
    return ws.policyVersion + 1;
  }

  async revoke(actor: Actor, ruleId: string, reason = ''): Promise<PolicyRule> {
    requireScope(actor, 'policy:grant');
    return this.t.retrying(async () => {
      const rule = await this.t.repo.rule(actor.principal.workspaceId, ruleId);
      if (rule.status === 'revoked') return rule;
      const tx = this.t.uow(actor);
      await this.bumpPolicyVersionTx(tx, 'policy.rule_revoked', { ruleId, reason });
      const saved = tx.save('rule', SPECS.rule, { ...rule, status: 'revoked' as const, revokedBy: actor.principal.id, revokedAt: tx.now }, 'rule.revoked', { payload: { reason } });
      await tx.commit(this.t.db);
      return saved;
    });
  }

  /** Amend = revoke the old rule and grant a new one that supersedes it, atomically. */
  async amend(actor: Actor, ruleId: string, input: Partial<GrantInput>): Promise<PolicyRule> {
    requireScope(actor, 'policy:grant');
    return this.t.retrying(async () => {
      const old = await this.t.repo.rule(actor.principal.workspaceId, ruleId);
      if (old.status !== 'active') fail('invalid_transition', 'only an active rule can be amended');
      const tx = this.t.uow(actor);
      tx.save('rule', SPECS.rule, { ...old, status: 'revoked' as const, revokedBy: actor.principal.id, revokedAt: tx.now }, 'rule.superseded', { payload: input });
      const next = await this.createRuleTx(
        tx,
        {
          effect: input.effect ?? old.effect,
          action: input.action ?? old.action,
          resource: input.resource ?? old.resource,
          grantee: input.grantee ?? old.grantee,
          conditions: input.conditions ?? old.conditions,
          expiresAt: input.expiresAt === undefined ? old.expiresAt : input.expiresAt,
          note: input.note ?? old.note,
        },
        old.source,
        old.id,
      );
      await tx.commit(this.t.db);
      return next;
    });
  }

  /** A chief (or human) suggests a rule. Proposals never authorize anything until a human accepts. */
  async propose(actor: Actor, input: GrantInput & { evidence?: string[] }): Promise<Proposal> {
    requireScope(actor, 'policy:propose');
    if ((input.effect ?? 'allow') !== 'allow') fail('invalid', 'proposals are for allow rules; a human can add deny rules directly');
    return this.createProposal(actor, input, input.evidence ?? []);
  }

  private async createProposal(actor: Actor, input: GrantInput, evidence: string[]): Promise<Proposal> {
    const ws = actor.principal.workspaceId;
    const key = approvalPatternKey(input.action, input.resource);
    const existing = (await this.t.repo.proposals(ws, 'pending')).find((p) => p.patternKey === key);
    if (existing) return existing;
    const tx = this.t.uow(actor);
    const proposal: Proposal = {
      id: this.t.id('prop'),
      workspaceId: ws,
      patternKey: key,
      proposed: {
        effect: 'allow',
        action: input.action,
        resource: input.resource,
        grantee: (input.grantee === 'tower' ? 'chief' : input.grantee) ?? 'chief',
        conditions: { ...(input.conditions ?? {}) },
        note: input.note ?? '',
      },
      evidence,
      status: 'pending',
      resolvedRuleId: null,
      resolvedBy: null,
      version: 0,
      createdAt: tx.now,
    };
    const saved = tx.save('proposal', PROPOSAL_SPEC, proposal, 'proposal.created', { payload: proposal.proposed });
    await tx.commit(this.t.db);
    return saved;
  }

  /**
   * Accept a proposal as proposed, or narrowed. Narrowing may only reduce scope:
   * a narrower resource pattern, a lower risk ceiling, fewer uses or an expiry.
   */
  async acceptProposal(actor: Actor, id: string, narrowed: Partial<GrantInput> = {}): Promise<PolicyRule> {
    requireScope(actor, 'policy:grant');
    const ws = actor.principal.workspaceId;
    return this.t.retrying(async () => {
      const prop = (await this.t.repo.proposals(ws)).find((p) => p.id === id) ?? fail('not_found', `proposal ${id} not found`);
      if (prop.status !== 'pending') fail('invalid_transition', `proposal is ${prop.status}`);
      const base = prop.proposed;
      const resource = narrowed.resource ?? base.resource;
      const action = narrowed.action ?? base.action;
      if (!matchPattern(base.resource, resource.replace(/\*/g, '')) || (resource.includes('*') && !base.resource.includes('*'))) {
        fail('invalid', 'narrowed resource must be within the proposed resource');
      }
      if (!matchPattern(base.action, action.replace(/\*/g, '')) || (action.includes('*') && !base.action.includes('*'))) fail('invalid', 'narrowed action must be within the proposed action');
      const conditions: RuleConditions = { ...(base.conditions as RuleConditions), ...(narrowed.conditions ?? {}) };
      const baseMax = (base.conditions as RuleConditions).maxRisk;
      if (baseMax && conditions.maxRisk && RISK_ORDER[conditions.maxRisk] > RISK_ORDER[baseMax]) fail('invalid', 'narrowing cannot raise the risk ceiling');
      const tx = this.t.uow(actor);
      const rule = await this.createRuleTx(
        tx,
        { effect: 'allow', action, resource, grantee: narrowed.grantee ?? base.grantee, conditions, expiresAt: narrowed.expiresAt ?? null, note: narrowed.note ?? base.note },
        'proposal',
        null,
      );
      tx.save('proposal', PROPOSAL_SPEC, { ...prop, status: 'accepted' as const, resolvedRuleId: rule.id, resolvedBy: actor.principal.id }, 'proposal.accepted', {
        payload: { ruleId: rule.id, narrowed },
      });
      await tx.commit(this.t.db);
      return rule;
    });
  }

  async declineProposal(actor: Actor, id: string): Promise<Proposal> {
    requireScope(actor, 'policy:grant');
    const ws = actor.principal.workspaceId;
    const prop = (await this.t.repo.proposals(ws)).find((p) => p.id === id) ?? fail('not_found', `proposal ${id} not found`);
    if (prop.status !== 'pending') fail('invalid_transition', `proposal is ${prop.status}`);
    const tx = this.t.uow(actor);
    const saved = tx.save('proposal', PROPOSAL_SPEC, { ...prop, status: 'declined' as const, resolvedBy: actor.principal.id }, 'proposal.declined');
    await tx.commit(this.t.db);
    return saved;
  }

  /** Non-authoritative preference. The policy evaluator never reads preferences. */
  async setPreference(actor: Actor, key: string, value: unknown): Promise<void> {
    requireScope(actor, 'policy:propose');
    await this.t.db.batch([
      {
        sql: `INSERT INTO preferences (workspace_id, key, value_json, observed_count, updated_at) VALUES (?, ?, ?, 0, ?)
              ON CONFLICT(workspace_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
        params: [actor.principal.workspaceId, key, JSON.stringify(value), this.t.now()],
      },
    ]);
  }

  /**
   * Record a human approval as an observation. After `proposalThreshold` similar
   * approvals Tower creates a proposal. It never creates a rule.
   */
  async observeApproval(actor: Actor, d: Decision): Promise<Proposal | null> {
    const ws = actor.principal.workspaceId;
    const { action, resource, risk } = d.requiredAuthority;
    const key = `approval:${approvalPatternKey(action, resource)}`;
    await this.t.db.batch([
      {
        sql: `INSERT INTO preferences (workspace_id, key, value_json, observed_count, updated_at) VALUES (?, ?, ?, 1, ?)
              ON CONFLICT(workspace_id, key) DO UPDATE SET observed_count = observed_count + 1, value_json = excluded.value_json, updated_at = excluded.updated_at`,
        params: [ws, key, JSON.stringify({ action, resource, lastDecision: d.id, risk }), this.t.now()],
      },
    ]);
    const pref = (await this.t.repo.preferences(ws)).find((p) => p.key === key);
    if (!pref || pref.observedCount < this.t.config.proposalThreshold) return null;
    const rules = await this.t.repo.rules(ws);
    const now = this.t.now();
    if (rules.some((r) => r.effect === 'allow' && ruleLive(r, now) && matchPattern(r.action, action) && matchPattern(r.resource, resource))) return null;
    if ((await this.t.repo.proposals(ws)).some((p) => p.patternKey === approvalPatternKey(action, resource) && p.status === 'declined')) return null;
    return this.createProposal(
      actor,
      {
        action,
        resource,
        grantee: 'chief',
        conditions: { maxRisk: risk },
        note: `You approved "${action}" on ${resource} ${pref.observedCount} times. Make it a standing rule for your Chief of Staff?`,
      },
      [d.id],
    );
  }
}
