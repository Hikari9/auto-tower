import { createHash } from 'node:crypto';
import type { PrincipalKind } from '../auth/principals.js';
import { ValidationError } from '../core/errors.js';
import { loadMission } from '../core/projection.js';
import type { CommandContext } from '../core/service.js';
import { RISKS } from '../core/types.js';
import { VersionConflictError } from '../events/errors.js';
import {
  createEventLog,
  type EventLog,
  type StoredEvent,
} from '../events/event-log.js';
import { newId } from '../shared/ids.js';
import type { SqlDatabase } from '../storage/database.js';
import { ACTION_PATTERN } from './actions.js';
import {
  AuthorityForbiddenError,
  PolicyDeniedError,
  ProposalNotFoundError,
  RuleNotFoundError,
  RuleStateError,
  WideningError,
} from './errors.js';
import { evaluate, riskAtMost } from './evaluate.js';
import type { CreateRuleInput, NarrowInput, RuleChanges } from './inputs.js';
import { isNarrowerPattern } from './patterns.js';
import {
  clearPolicyProjection,
  loadPolicyVersion,
  loadPreferences,
  loadProposal,
  loadProposals,
  loadReceipts,
  loadRule,
  loadRules,
  POLICY_STREAM,
  type PolicyEventPayloads,
  PREFERENCES_STREAM,
  projectPolicyEvent,
  type RuleSnapshot,
  requestSignature,
} from './store.js';
import { joinTransaction } from './transaction.js';
import type {
  ApprovalObservation,
  AuthorizeRequest,
  HistoryPage,
  PolicyEvaluation,
  PolicyProposal,
  PolicyReceipt,
  PolicyRule,
  Preference,
  ProposalStatus,
} from './types.js';

export type AuthorityContext = Pick<
  CommandContext,
  'workspaceId' | 'actor' | 'correlationId' | 'idempotencyKey'
>;

/** Approvals of one kind of request before Tower proposes a standing rule for it. */
export const PROPOSAL_THRESHOLD = 3;

export interface RuleResult {
  rule: PolicyRule;
  /** Workspace policy version after the change. */
  policyVersion: number;
  replayed: boolean;
}

export interface PolicyServiceDeps {
  db: SqlDatabase;
  clock?: () => Date;
  newId?: (prefix: string) => string;
}

export interface PolicyService {
  /**
   * Decides one request against the latest committed policy. Read-only, so it is safe inside
   * any transaction. Only an `allow` permits the effect.
   */
  authorize(
    request: AuthorizeRequest,
    options?: { escalate?: boolean },
  ): PolicyEvaluation;
  /**
   * Decides as if any Chief of Staff asked, to learn whether a delegated rule covers the request
   * before one has been asked. Rules held by one named principal do not count here.
   */
  authorizeDelegate(
    request: Omit<AuthorizeRequest, 'principal'>,
    options?: { escalate?: boolean },
  ): PolicyEvaluation;
  /**
   * Authorizes at the point of effect: records a receipt and throws unless the request is
   * allowed. Opens a transaction, so call it outside one, or use `authorize` and `record`.
   */
  guard(request: AuthorizeRequest): PolicyEvaluation;
  /** Stores evidence that a request was refused or sent to a person. Allowed evaluations are not stored. */
  record(request: AuthorizeRequest, evaluation: PolicyEvaluation): void;

  policyVersion(workspaceId: string): number;
  getRule(workspaceId: string, id: string): PolicyRule | undefined;
  listRules(
    workspaceId: string,
    filter?: { status?: 'active' | 'inactive' | 'all' },
  ): PolicyRule[];
  createRule(ctx: AuthorityContext, input: CreateRuleInput): RuleResult;
  amendRule(
    ctx: AuthorityContext,
    ruleId: string,
    expectedVersion: number,
    changes: RuleChanges,
  ): RuleResult;
  revokeRule(
    ctx: AuthorityContext,
    ruleId: string,
    expectedVersion: number,
    reason: string | null,
  ): RuleResult;

  /** Every authority event in order, optionally for one rule or proposal. */
  history(
    workspaceId: string,
    page: { afterVersion: number; limit: number },
    filter?: { ruleId?: string; proposalId?: string },
  ): HistoryPage;
  receipts(
    workspaceId: string,
    page: { afterSeq: number; limit: number },
  ): PolicyReceipt[];

  setPreference(ctx: AuthorityContext, key: string, value: unknown): Preference;
  listPreferences(workspaceId: string): Preference[];

  listProposals(workspaceId: string, status?: ProposalStatus): PolicyProposal[];
  getProposal(workspaceId: string, id: string): PolicyProposal | undefined;
  acceptProposal(
    ctx: AuthorityContext,
    proposalId: string,
    note: string | null,
  ): { proposal: PolicyProposal; rule: PolicyRule };
  narrowProposal(
    ctx: AuthorityContext,
    proposalId: string,
    narrowing: NarrowInput,
  ): { proposal: PolicyProposal; rule: PolicyRule };
  declineProposal(
    ctx: AuthorityContext,
    proposalId: string,
    note: string | null,
  ): PolicyProposal;

  /**
   * Counts a human approval of a described request. Repeats reach a threshold, which creates a
   * pending proposal and nothing else. The proposal authorizes nothing until a human accepts it.
   */
  observeApproval(
    workspaceId: string,
    observation: ApprovalObservation,
  ): PolicyProposal | undefined;
  /** Stops counting an approval whose decision was later answered differently. */
  withdrawApproval(workspaceId: string, decisionId: string, at: string): void;

  /** Rewrites the authority projection of one workspace from its events alone. */
  rebuildProjection(workspaceId: string): void;
}

export function createPolicyService(deps: PolicyServiceDeps): PolicyService {
  const { db } = deps;
  const clock = deps.clock ?? (() => new Date());
  const ids = deps.newId ?? newId;

  function inTransaction<T>(fn: (tx: SqlDatabase, log: EventLog) => T): T {
    return db.transaction((tx) => {
      const joined = joinTransaction(tx);
      return fn(joined, createEventLog(joined));
    });
  }

  function requireHuman(ctx: AuthorityContext, command: string): void {
    if (ctx.actor.kind !== 'human') {
      throw new AuthorityForbiddenError(command, ctx.actor.kind);
    }
  }

  function correlation(ctx: AuthorityContext): string {
    return ctx.correlationId ?? ctx.idempotencyKey ?? ids('cor');
  }

  /** Appends at the stream's current version. The surrounding write transaction serializes writers. */
  function append<K extends keyof PolicyEventPayloads>(
    tx: SqlDatabase,
    log: EventLog,
    ctx: AuthorityContext,
    type: K,
    payload: PolicyEventPayloads[K],
  ): StoredEvent {
    return appendTo(tx, log, ctx, POLICY_STREAM, type, payload);
  }

  function appendTo(
    tx: SqlDatabase,
    log: EventLog,
    ctx: AuthorityContext,
    streamId: string,
    type: string,
    payload: unknown,
  ): StoredEvent {
    const current =
      tx.get<{ version: number }>(
        'SELECT COALESCE(MAX(version), 0) AS version FROM events WHERE workspace_id = ? AND stream_id = ?',
        [ctx.workspaceId, streamId],
      )?.version ?? 0;
    return log.append({
      workspaceId: ctx.workspaceId,
      streamId,
      expectedVersion: current,
      type,
      payload,
      actorId: ctx.actor.id,
      correlationId: correlation(ctx),
    }).event;
  }

  function snapshotOf(rule: PolicyRule): RuleSnapshot {
    const { createdSeq: _seq, ...rest } = rule;
    return rest;
  }

  function requirePrincipalInWorkspace(
    tx: SqlDatabase,
    workspaceId: string,
    principalId: string | null,
    path: string,
  ): void {
    if (principalId === null) {
      return;
    }
    const found = tx.get<{ id: string }>(
      'SELECT id FROM principals WHERE id = ? AND workspace_id = ?',
      [principalId, workspaceId],
    );
    if (found === undefined) {
      throw new ValidationError([
        { path, message: 'is not a principal in this workspace' },
      ]);
    }
  }

  function requireFuture(expiresAt: string | null, path: string): void {
    if (expiresAt !== null && Date.parse(expiresAt) <= clock().getTime()) {
      throw new ValidationError([{ path, message: 'must be in the future' }]);
    }
  }

  function checkRuleShape(rule: PolicyRule): void {
    if (
      rule.effect === 'allow' &&
      rule.grantee.kind === null &&
      rule.grantee.principalId === null
    ) {
      throw new ValidationError([
        { path: 'grantee', message: 'is required for a grant' },
      ]);
    }
    // A deny rule applies at every risk and amount, so a cap would silently narrow it.
    if (rule.effect === 'deny' && rule.limits.maxAmount !== null) {
      throw new ValidationError([
        {
          path: 'limits.maxAmount',
          message: 'does not apply to a deny rule',
        },
      ]);
    }
  }

  function newRule(
    ctx: AuthorityContext,
    id: string,
    input: CreateRuleInput,
    at: string,
    sourceProposalId: string | null,
  ): PolicyRule {
    return {
      id,
      workspaceId: ctx.workspaceId,
      version: 1,
      createdSeq: 0,
      effect: input.effect,
      action: input.action,
      resource: input.resource,
      scope: input.scope,
      // A deny rule applies at every risk.
      maxRisk: input.effect === 'deny' ? 'high' : input.maxRisk,
      grantee: input.grantee,
      limits: input.limits,
      note: input.note,
      expiresAt: input.expiresAt,
      createdBy: ctx.actor.id,
      createdAt: at,
      updatedBy: ctx.actor.id,
      updatedAt: at,
      revokedAt: null,
      revokedBy: null,
      revokeReason: null,
      sourceProposalId,
    };
  }

  function insertRule(
    tx: SqlDatabase,
    log: EventLog,
    ctx: AuthorityContext,
    rule: PolicyRule,
  ): { rule: PolicyRule; policyVersion: number } {
    checkRuleShape(rule);
    requirePrincipalInWorkspace(
      tx,
      ctx.workspaceId,
      rule.grantee.principalId,
      'grantee.principalId',
    );
    requireFuture(rule.expiresAt, 'expiresAt');
    const policyVersion = loadPolicyVersion(tx, ctx.workspaceId) + 1;
    const event = append(tx, log, ctx, 'policy.rule.created', {
      rule: snapshotOf(rule),
      policyVersion,
    });
    projectPolicyEvent(tx, event);
    return {
      rule: requireRule(tx, ctx.workspaceId, rule.id),
      policyVersion,
    };
  }

  function requireRule(
    tx: SqlDatabase,
    workspaceId: string,
    id: string,
  ): PolicyRule {
    const rule = loadRule(tx, workspaceId, id);
    if (rule === undefined) {
      throw new RuleNotFoundError(id);
    }
    return rule;
  }

  function requireVersion(rule: PolicyRule, expected: number): void {
    if (rule.version !== expected) {
      throw new VersionConflictError(
        `policy-rule:${rule.id}`,
        expected,
        rule.version,
      );
    }
  }

  /** Same key from the same actor names the same rule, so a retry finds it instead of creating a second. */
  function derivedRuleId(ctx: AuthorityContext): string {
    const digest = createHash('sha256')
      .update(`${ctx.workspaceId}\0${ctx.actor.id}\0${ctx.idempotencyKey}`)
      .digest('hex');
    return `rul_${digest.slice(0, 32)}`;
  }

  function resolveProposal(
    tx: SqlDatabase,
    log: EventLog,
    ctx: AuthorityContext,
    proposal: PolicyProposal,
    status: 'accepted' | 'narrowed' | 'declined',
    note: string | null,
    ruleId: string | null,
  ): PolicyProposal {
    const resolved: PolicyProposal = {
      ...proposal,
      status,
      resolvedAt: clock().toISOString(),
      resolvedBy: ctx.actor.id,
      resolutionNote: note,
      resultingRuleId: ruleId,
    };
    const event = append(tx, log, ctx, 'policy.proposal.resolved', {
      proposal: resolved,
      policyVersion: loadPolicyVersion(tx, ctx.workspaceId),
    });
    projectPolicyEvent(tx, event);
    return resolved;
  }

  function pendingProposal(
    tx: SqlDatabase,
    workspaceId: string,
    id: string,
  ): PolicyProposal {
    const proposal = loadProposal(tx, workspaceId, id);
    if (proposal === undefined) {
      throw new ProposalNotFoundError(id);
    }
    if (proposal.status !== 'pending') {
      throw new RuleStateError(`Proposal ${id} was already ${proposal.status}`);
    }
    return proposal;
  }

  function grantFromProposal(
    tx: SqlDatabase,
    log: EventLog,
    ctx: AuthorityContext,
    proposal: PolicyProposal,
    narrowing: NarrowInput | null,
  ): PolicyRule {
    const input: CreateRuleInput = {
      effect: 'allow',
      action: proposal.action,
      resource: narrowing?.resource ?? proposal.resource,
      scope: narrowing?.scope ?? proposal.scope,
      maxRisk: narrowing?.maxRisk ?? proposal.maxRisk,
      grantee: {
        kind: proposal.granteeKind,
        principalId: narrowing?.granteePrincipalId ?? null,
      },
      limits: {
        maxAmount: narrowing?.maxAmount ?? proposal.limits.maxAmount,
        missionIds: narrowing?.missionIds ?? proposal.limits.missionIds,
      },
      expiresAt: narrowing?.expiresAt ?? null,
      note: narrowing?.note ?? `From proposal ${proposal.id}`,
    };
    return insertRule(
      tx,
      log,
      ctx,
      newRule(ctx, ids('rul'), input, clock().toISOString(), proposal.id),
    ).rule;
  }

  /** A narrowing may only keep or tighten what the proposal described. */
  function checkNarrower(
    proposal: PolicyProposal,
    narrowing: NarrowInput,
  ): void {
    if (
      narrowing.resource !== undefined &&
      !isNarrowerPattern(narrowing.resource, proposal.resource)
    ) {
      throw new WideningError('resource');
    }
    if (
      narrowing.scope !== undefined &&
      !isNarrowerPattern(narrowing.scope, proposal.scope)
    ) {
      throw new WideningError('scope');
    }
    if (
      narrowing.maxRisk !== undefined &&
      !riskAtMost(narrowing.maxRisk, proposal.maxRisk)
    ) {
      throw new WideningError('maxRisk');
    }
    const { maxAmount, missionIds } = proposal.limits;
    if (
      narrowing.maxAmount !== undefined &&
      maxAmount !== null &&
      narrowing.maxAmount > maxAmount
    ) {
      throw new WideningError('maxAmount');
    }
    if (
      narrowing.missionIds !== undefined &&
      missionIds !== null &&
      !narrowing.missionIds.every((id) => missionIds.includes(id))
    ) {
      throw new WideningError('missionIds');
    }
  }

  function producersOf(
    workspaceId: string,
    request: AuthorizeRequest,
  ): Set<string> {
    const producers = new Set<string>(request.producerIds ?? []);
    if (request.missionId !== undefined) {
      const mission = loadMission(db, workspaceId, request.missionId);
      for (const attempt of mission?.attempts ?? []) {
        producers.add(attempt.runnerId);
        if (attempt.report !== null) {
          producers.add(attempt.report.by);
        }
      }
    }
    return producers;
  }

  function validateRequest(request: AuthorizeRequest): void {
    const issues = [];
    if (!ACTION_PATTERN.test(request.action)) {
      issues.push({
        path: 'action',
        message: 'must be lower-case dotted segments',
      });
    }
    if (request.resource === '' || request.scope === '') {
      issues.push({ path: 'resource', message: 'and scope must not be empty' });
    }
    if (!(RISKS as readonly string[]).includes(request.risk)) {
      issues.push({ path: 'risk', message: 'must be low, medium or high' });
    }
    if (
      request.amount !== undefined &&
      (!Number.isInteger(request.amount) || request.amount < 0)
    ) {
      issues.push({
        path: 'amount',
        message: 'must be a non-negative integer',
      });
    }
    if (issues.length > 0) {
      throw new ValidationError(issues);
    }
  }

  function decide(
    request: AuthorizeRequest,
    principal: { id: string; kind: PrincipalKind } | undefined,
    principalDisabled: boolean,
    escalate: boolean,
  ): PolicyEvaluation {
    const workspaceId = request.workspace;
    return evaluate({
      rules: loadRules(db, workspaceId),
      policyVersion: loadPolicyVersion(db, workspaceId),
      now: clock(),
      principal,
      principalDisabled,
      action: request.action,
      resource: request.resource,
      scope: request.scope,
      risk: request.risk,
      amount: request.amount,
      missionId: request.missionId,
      producers: producersOf(workspaceId, request),
      escalate,
    });
  }

  const service: PolicyService = {
    authorize(request, options) {
      validateRequest(request);
      const workspaceId = request.workspace;
      const principalId =
        typeof request.principal === 'string'
          ? request.principal
          : request.principal.id;
      const row = db.get<{ kind: string; disabled_at: string | null }>(
        'SELECT kind, disabled_at FROM principals WHERE id = ? AND workspace_id = ?',
        [principalId, workspaceId],
      );
      return decide(
        request,
        row === undefined
          ? undefined
          : { id: principalId, kind: row.kind as PrincipalKind },
        row?.disabled_at != null,
        options?.escalate ?? false,
      );
    },

    authorizeDelegate(request, options) {
      const full = { ...request, principal: '' };
      validateRequest(full);
      return decide(
        full,
        { id: '', kind: 'chief_of_staff' },
        false,
        options?.escalate ?? false,
      );
    },

    guard(request) {
      const evaluation = service.authorize(request);
      if (evaluation.effect !== 'allow') {
        service.record(request, evaluation);
        throw new PolicyDeniedError(
          evaluation.effect,
          evaluation.reason,
          evaluation.policyRef,
        );
      }
      return evaluation;
    },

    record(request, evaluation) {
      if (evaluation.effect === 'allow') {
        return;
      }
      const principalId =
        typeof request.principal === 'string'
          ? request.principal
          : request.principal.id;
      // The foreign key needs a real principal, and an unknown one has nothing to attribute to.
      if (evaluation.code === 'unknown_principal') {
        return;
      }
      db.run(
        `INSERT INTO policy_receipts (workspace_id, principal_id, action, resource, scope, risk, amount, mission_id, effect, code, reason, rule_id, rule_version, policy_version, evaluated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          request.workspace,
          principalId,
          request.action,
          request.resource,
          request.scope,
          request.risk,
          request.amount ?? null,
          request.missionId ?? null,
          evaluation.effect,
          evaluation.code,
          evaluation.reason,
          evaluation.ruleId,
          evaluation.ruleVersion,
          evaluation.policyVersion,
          evaluation.evaluatedAt,
        ],
      );
    },

    policyVersion: (workspaceId) => loadPolicyVersion(db, workspaceId),

    getRule: (workspaceId, id) => loadRule(db, workspaceId, id),

    listRules(workspaceId, filter) {
      const status = filter?.status ?? 'all';
      const now = clock().getTime();
      const live = (rule: PolicyRule) =>
        rule.revokedAt === null &&
        (rule.expiresAt === null || Date.parse(rule.expiresAt) > now);
      return loadRules(db, workspaceId).filter(
        (rule) => status === 'all' || (status === 'active') === live(rule),
      );
    },

    createRule(ctx, input) {
      requireHuman(ctx, 'create a grant or deny rule');
      const at = clock().toISOString();
      return inTransaction((tx, log) => {
        if (ctx.idempotencyKey !== undefined) {
          const id = derivedRuleId(ctx);
          const existing = loadRule(tx, ctx.workspaceId, id);
          if (existing !== undefined) {
            const created = firstCreation(log, ctx.workspaceId, id);
            if (!sameRequest(created, input)) {
              throw new ValidationError([
                {
                  path: 'idempotency-key',
                  message: 'was already used for a different rule',
                },
              ]);
            }
            return {
              rule: existing,
              policyVersion: loadPolicyVersion(tx, ctx.workspaceId),
              replayed: true,
            };
          }
          return {
            ...insertRule(tx, log, ctx, newRule(ctx, id, input, at, null)),
            replayed: false,
          };
        }
        return {
          ...insertRule(
            tx,
            log,
            ctx,
            newRule(ctx, ids('rul'), input, at, null),
          ),
          replayed: false,
        };
      });
    },

    amendRule(ctx, ruleId, expectedVersion, changes) {
      requireHuman(ctx, 'amend a grant or deny rule');
      return inTransaction((tx, log) => {
        const current = requireRule(tx, ctx.workspaceId, ruleId);
        requireVersion(current, expectedVersion);
        if (current.revokedAt !== null) {
          throw new RuleStateError(
            `Rule ${ruleId} is revoked. Create a new rule instead.`,
          );
        }
        const next: PolicyRule = {
          ...current,
          ...changes,
          maxRisk:
            current.effect === 'deny'
              ? 'high'
              : (changes.maxRisk ?? current.maxRisk),
          version: current.version + 1,
          updatedBy: ctx.actor.id,
          updatedAt: clock().toISOString(),
        };
        checkRuleShape(next);
        requirePrincipalInWorkspace(
          tx,
          ctx.workspaceId,
          next.grantee.principalId,
          'grantee.principalId',
        );
        if (changes.expiresAt !== undefined) {
          requireFuture(next.expiresAt, 'expiresAt');
        }
        const policyVersion = loadPolicyVersion(tx, ctx.workspaceId) + 1;
        const event = append(tx, log, ctx, 'policy.rule.amended', {
          rule: snapshotOf(next),
          changed: Object.keys(changes),
          policyVersion,
        });
        projectPolicyEvent(tx, event);
        return {
          rule: requireRule(tx, ctx.workspaceId, ruleId),
          policyVersion,
          replayed: false,
        };
      });
    },

    revokeRule(ctx, ruleId, expectedVersion, reason) {
      requireHuman(ctx, 'revoke a grant or deny rule');
      return inTransaction((tx, log) => {
        const current = requireRule(tx, ctx.workspaceId, ruleId);
        requireVersion(current, expectedVersion);
        if (current.revokedAt !== null) {
          throw new RuleStateError(`Rule ${ruleId} is already revoked`);
        }
        const at = clock().toISOString();
        const next: PolicyRule = {
          ...current,
          version: current.version + 1,
          updatedBy: ctx.actor.id,
          updatedAt: at,
          revokedAt: at,
          revokedBy: ctx.actor.id,
          revokeReason: reason,
        };
        const policyVersion = loadPolicyVersion(tx, ctx.workspaceId) + 1;
        const event = append(tx, log, ctx, 'policy.rule.revoked', {
          rule: snapshotOf(next),
          policyVersion,
        });
        projectPolicyEvent(tx, event);
        return {
          rule: requireRule(tx, ctx.workspaceId, ruleId),
          policyVersion,
          replayed: false,
        };
      });
    },

    history(workspaceId, { afterVersion, limit }, filter) {
      const events = createEventLog(db).readStream(workspaceId, POLICY_STREAM);
      const matching = events.filter(
        (event) => event.version > afterVersion && matchesFilter(event, filter),
      );
      const page = matching.slice(0, limit);
      const last = page[page.length - 1];
      return {
        items: page.map((event) => ({
          version: event.version,
          seq: event.seq,
          type: event.type,
          actorId: event.actorId,
          correlationId: event.correlationId,
          recordedAt: event.recordedAt,
          payload: event.payload,
        })),
        nextAfterVersion:
          last !== undefined && matching.length > page.length
            ? last.version
            : null,
      };
    },

    receipts: (workspaceId, { afterSeq, limit }) =>
      loadReceipts(db, workspaceId, afterSeq, limit),

    setPreference(ctx, key, value) {
      requireHuman(ctx, 'record a preference');
      return inTransaction((tx, log) => {
        const previous = tx.get<{ version: number }>(
          'SELECT version FROM preferences WHERE workspace_id = ? AND key = ?',
          [ctx.workspaceId, key],
        );
        const version = (previous?.version ?? 0) + 1;
        const at = clock().toISOString();
        appendTo(tx, log, ctx, PREFERENCES_STREAM, 'preference.set', {
          key,
          value,
          version,
          at,
        });
        tx.run(
          `INSERT INTO preferences (workspace_id, key, value_json, version, updated_by, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (workspace_id, key) DO UPDATE SET value_json = excluded.value_json, version = excluded.version, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
          [
            ctx.workspaceId,
            key,
            JSON.stringify(value),
            version,
            ctx.actor.id,
            at,
          ],
        );
        return { key, value, version, updatedBy: ctx.actor.id, updatedAt: at };
      });
    },

    listPreferences: (workspaceId) => loadPreferences(db, workspaceId),

    listProposals: (workspaceId, status) =>
      loadProposals(db, workspaceId, status),
    getProposal: (workspaceId, id) => loadProposal(db, workspaceId, id),

    acceptProposal(ctx, proposalId, note) {
      requireHuman(ctx, 'accept a proposal');
      return inTransaction((tx, log) => {
        const proposal = pendingProposal(tx, ctx.workspaceId, proposalId);
        const rule = grantFromProposal(tx, log, ctx, proposal, null);
        return {
          proposal: resolveProposal(
            tx,
            log,
            ctx,
            proposal,
            'accepted',
            note,
            rule.id,
          ),
          rule,
        };
      });
    },

    narrowProposal(ctx, proposalId, narrowing) {
      requireHuman(ctx, 'accept a proposal');
      return inTransaction((tx, log) => {
        const proposal = pendingProposal(tx, ctx.workspaceId, proposalId);
        checkNarrower(proposal, narrowing);
        const rule = grantFromProposal(tx, log, ctx, proposal, narrowing);
        return {
          proposal: resolveProposal(
            tx,
            log,
            ctx,
            proposal,
            'narrowed',
            narrowing.note,
            rule.id,
          ),
          rule,
        };
      });
    },

    declineProposal(ctx, proposalId, note) {
      requireHuman(ctx, 'decline a proposal');
      return inTransaction((tx, log) =>
        resolveProposal(
          tx,
          log,
          ctx,
          pendingProposal(tx, ctx.workspaceId, proposalId),
          'declined',
          note,
          null,
        ),
      );
    },

    observeApproval(workspaceId, observation) {
      const signature = requestSignature(observation);
      return inTransaction((tx, log) => {
        tx.run(
          `INSERT OR REPLACE INTO approval_observations (workspace_id, decision_id, signature, action, resource, scope, risk, amount, approved_by, approved_at, withdrawn_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
          [
            workspaceId,
            observation.decisionId,
            signature,
            observation.action,
            observation.resource,
            observation.scope,
            observation.risk,
            observation.amount,
            observation.approvedBy,
            observation.at,
          ],
        );
        const seen = tx.all<{ decision_id: string; amount: number | null }>(
          'SELECT decision_id, amount FROM approval_observations WHERE workspace_id = ? AND signature = ? AND withdrawn_at IS NULL ORDER BY approved_at, decision_id',
          [workspaceId, signature],
        );
        if (seen.length < PROPOSAL_THRESHOLD) {
          return undefined;
        }
        const open = tx.get<{ id: string }>(
          "SELECT id FROM policy_proposals WHERE workspace_id = ? AND signature = ? AND status IN ('pending', 'declined')",
          [workspaceId, signature],
        );
        if (open !== undefined) {
          return undefined;
        }
        const amounts = seen.flatMap((s) =>
          s.amount === null ? [] : [s.amount],
        );
        // The proposal keeps exactly what was approved: this action, resource, scope and risk,
        // and no more than the largest amount that was ever approved.
        const proposal: PolicyProposal = {
          id: ids('prp'),
          workspaceId,
          status: 'pending',
          action: observation.action,
          resource: observation.resource,
          scope: observation.scope,
          maxRisk: observation.risk,
          granteeKind: 'chief_of_staff',
          limits: {
            maxAmount: amounts.length > 0 ? Math.max(...amounts) : null,
            missionIds: null,
          },
          evidence: seen.map((s) => s.decision_id),
          approvals: seen.length,
          createdAt: observation.at,
          resolvedAt: null,
          resolvedBy: null,
          resolutionNote: null,
          resultingRuleId: null,
        };
        const event = append(
          tx,
          log,
          { workspaceId, actor: { id: observation.approvedBy, kind: 'human' } },
          'policy.proposal.created',
          { proposal, policyVersion: loadPolicyVersion(tx, workspaceId) },
        );
        projectPolicyEvent(tx, event);
        return proposal;
      });
    },

    withdrawApproval(workspaceId, decisionId, at) {
      db.run(
        'UPDATE approval_observations SET withdrawn_at = ? WHERE workspace_id = ? AND decision_id = ? AND withdrawn_at IS NULL',
        [at, workspaceId, decisionId],
      );
    },

    rebuildProjection(workspaceId) {
      inTransaction((tx, log) => {
        clearPolicyProjection(tx, workspaceId);
        for (const event of log.readStream(workspaceId, POLICY_STREAM)) {
          projectPolicyEvent(tx, event);
        }
      });
    },
  };
  return service;
}

function matchesFilter(
  event: StoredEvent,
  filter: { ruleId?: string; proposalId?: string } | undefined,
): boolean {
  if (filter?.ruleId === undefined && filter?.proposalId === undefined) {
    return true;
  }
  const payload = event.payload as {
    rule?: { id: string; sourceProposalId: string | null };
    proposal?: { id: string };
  };
  return (
    (filter.ruleId !== undefined && payload.rule?.id === filter.ruleId) ||
    (filter.proposalId !== undefined &&
      (payload.proposal?.id === filter.proposalId ||
        payload.rule?.sourceProposalId === filter.proposalId))
  );
}

function firstCreation(
  log: EventLog,
  workspaceId: string,
  ruleId: string,
): RuleSnapshot | undefined {
  for (const event of log.readStream(workspaceId, POLICY_STREAM)) {
    const { rule } = event.payload as { rule?: RuleSnapshot };
    if (event.type === 'policy.rule.created' && rule?.id === ruleId) {
      return rule;
    }
  }
  return undefined;
}

function sameRequest(
  rule: RuleSnapshot | undefined,
  input: CreateRuleInput,
): boolean {
  return (
    rule !== undefined &&
    rule.effect === input.effect &&
    rule.action === input.action &&
    rule.resource === input.resource &&
    rule.scope === input.scope &&
    rule.grantee.kind === input.grantee.kind &&
    rule.grantee.principalId === input.grantee.principalId &&
    JSON.stringify(rule.limits) === JSON.stringify(input.limits) &&
    rule.expiresAt === input.expiresAt &&
    (input.effect === 'deny' || rule.maxRisk === input.maxRisk)
  );
}
