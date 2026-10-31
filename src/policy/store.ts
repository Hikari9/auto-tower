import type { PrincipalKind } from '../auth/principals.js';
import type { Risk } from '../core/types.js';
import type { StoredEvent } from '../events/event-log.js';
import type { SqlDatabase } from '../storage/database.js';
import type {
  PolicyProposal,
  PolicyReceipt,
  PolicyRule,
  Preference,
  ProposalStatus,
  RuleEffect,
  RuleLimits,
} from './types.js';

/** Stream ids. One authority stream per workspace, so its versions order every authority change. */
export const POLICY_STREAM = 'policy';
export const PREFERENCES_STREAM = 'preferences';

interface RuleRow {
  workspace_id: string;
  id: string;
  version: number;
  created_seq: number;
  effect: string;
  action: string;
  resource: string;
  scope: string;
  max_risk: string;
  grantee_kind: string | null;
  grantee_principal_id: string | null;
  limits_json: string;
  note: string | null;
  expires_at: string | null;
  created_by: string;
  created_at: string;
  updated_by: string;
  updated_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
  revoke_reason: string | null;
  source_proposal_id: string | null;
}

const RULE_COLUMNS =
  'workspace_id, id, version, created_seq, effect, action, resource, scope, max_risk, grantee_kind, grantee_principal_id, limits_json, note, expires_at, created_by, created_at, updated_by, updated_at, revoked_at, revoked_by, revoke_reason, source_proposal_id';

function toRule(row: RuleRow): PolicyRule {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    version: row.version,
    createdSeq: row.created_seq,
    effect: row.effect as RuleEffect,
    action: row.action,
    resource: row.resource,
    scope: row.scope,
    maxRisk: row.max_risk as Risk,
    grantee: {
      kind: row.grantee_kind as PrincipalKind | null,
      principalId: row.grantee_principal_id,
    },
    limits: JSON.parse(row.limits_json) as RuleLimits,
    note: row.note,
    expiresAt: row.expires_at,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
    revokedAt: row.revoked_at,
    revokedBy: row.revoked_by,
    revokeReason: row.revoke_reason,
    sourceProposalId: row.source_proposal_id,
  };
}

export function loadRules(db: SqlDatabase, workspaceId: string): PolicyRule[] {
  return db
    .all<RuleRow>(
      `SELECT ${RULE_COLUMNS} FROM policy_rules WHERE workspace_id = ? ORDER BY created_seq, id`,
      [workspaceId],
    )
    .map(toRule);
}

export function loadRule(
  db: SqlDatabase,
  workspaceId: string,
  id: string,
): PolicyRule | undefined {
  const row = db.get<RuleRow>(
    `SELECT ${RULE_COLUMNS} FROM policy_rules WHERE workspace_id = ? AND id = ?`,
    [workspaceId, id],
  );
  return row === undefined ? undefined : toRule(row);
}

export function loadPolicyVersion(
  db: SqlDatabase,
  workspaceId: string,
): number {
  return (
    db.get<{ version: number }>(
      'SELECT version FROM policy_state WHERE workspace_id = ?',
      [workspaceId],
    )?.version ?? 0
  );
}

/** What an event stores of a rule. `createdSeq` is the event's own `seq`, so it is not repeated. */
export type RuleSnapshot = Omit<PolicyRule, 'createdSeq'>;

export type ProposalSnapshot = PolicyProposal;

/** The authority-stream event payloads. Each carries the full state it produced, so history stands alone. */
export interface PolicyEventPayloads {
  'policy.rule.created': { rule: RuleSnapshot; policyVersion: number };
  'policy.rule.amended': {
    rule: RuleSnapshot;
    changed: string[];
    policyVersion: number;
  };
  'policy.rule.revoked': { rule: RuleSnapshot; policyVersion: number };
  'policy.proposal.created': {
    proposal: ProposalSnapshot;
    policyVersion: number;
  };
  'policy.proposal.resolved': {
    proposal: ProposalSnapshot;
    policyVersion: number;
  };
}

function writeRule(
  db: SqlDatabase,
  rule: RuleSnapshot,
  createdSeq: number,
  insert: boolean,
): void {
  const values = [
    rule.version,
    rule.effect,
    rule.action,
    rule.resource,
    rule.scope,
    rule.maxRisk,
    rule.grantee.kind,
    rule.grantee.principalId,
    JSON.stringify(rule.limits),
    rule.note,
    rule.expiresAt,
    rule.updatedBy,
    rule.updatedAt,
    rule.revokedAt,
    rule.revokedBy,
    rule.revokeReason,
    rule.sourceProposalId,
  ] as const;
  if (insert) {
    db.run(
      `INSERT INTO policy_rules (workspace_id, id, created_seq, created_by, created_at, version, effect, action, resource, scope, max_risk, grantee_kind, grantee_principal_id, limits_json, note, expires_at, updated_by, updated_at, revoked_at, revoked_by, revoke_reason, source_proposal_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        rule.workspaceId,
        rule.id,
        createdSeq,
        rule.createdBy,
        rule.createdAt,
        ...values,
      ],
    );
    return;
  }
  db.run(
    `UPDATE policy_rules SET version = ?, effect = ?, action = ?, resource = ?, scope = ?, max_risk = ?, grantee_kind = ?, grantee_principal_id = ?, limits_json = ?, note = ?, expires_at = ?, updated_by = ?, updated_at = ?, revoked_at = ?, revoked_by = ?, revoke_reason = ?, source_proposal_id = ?
     WHERE workspace_id = ? AND id = ?`,
    [...values, rule.workspaceId, rule.id],
  );
}

function setPolicyVersion(
  db: SqlDatabase,
  workspaceId: string,
  version: number,
): void {
  db.run(
    `INSERT INTO policy_state (workspace_id, version) VALUES (?, ?)
     ON CONFLICT (workspace_id) DO UPDATE SET version = excluded.version`,
    [workspaceId, version],
  );
}

function writeProposal(
  db: SqlDatabase,
  proposal: ProposalSnapshot,
  insert: boolean,
): void {
  if (insert) {
    db.run(
      `INSERT INTO policy_proposals (workspace_id, id, status, signature, action, resource, scope, max_risk, grantee_kind, limits_json, evidence_json, approvals, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        proposal.workspaceId,
        proposal.id,
        proposal.status,
        proposalSignature(proposal),
        proposal.action,
        proposal.resource,
        proposal.scope,
        proposal.maxRisk,
        proposal.granteeKind,
        JSON.stringify(proposal.limits),
        JSON.stringify(proposal.evidence),
        proposal.approvals,
        proposal.createdAt,
      ],
    );
    return;
  }
  db.run(
    `UPDATE policy_proposals SET status = ?, resolved_at = ?, resolved_by = ?, resolution_note = ?, resulting_rule_id = ?
     WHERE workspace_id = ? AND id = ?`,
    [
      proposal.status,
      proposal.resolvedAt,
      proposal.resolvedBy,
      proposal.resolutionNote,
      proposal.resultingRuleId,
      proposal.workspaceId,
      proposal.id,
    ],
  );
}

/** Identifies a request pattern, so repeated approvals of the same kind of request can be counted. */
export function requestSignature(request: {
  action: string;
  resource: string;
  scope: string;
  risk: string;
}): string {
  return JSON.stringify([
    request.action,
    request.resource,
    request.scope,
    request.risk,
  ]);
}

function proposalSignature(proposal: {
  action: string;
  resource: string;
  scope: string;
  maxRisk: string;
}): string {
  return requestSignature({ ...proposal, risk: proposal.maxRisk });
}

/**
 * The only writer of the authority projection, used by every command and by rebuild. Applying
 * the same events in order always yields the same rows.
 */
export function projectPolicyEvent(db: SqlDatabase, event: StoredEvent): void {
  const workspaceId = event.workspaceId;
  switch (event.type) {
    case 'policy.rule.created': {
      const { rule, policyVersion } =
        event.payload as PolicyEventPayloads['policy.rule.created'];
      writeRule(db, rule, event.seq, true);
      setPolicyVersion(db, workspaceId, policyVersion);
      return;
    }
    case 'policy.rule.amended':
    case 'policy.rule.revoked': {
      const { rule, policyVersion } = event.payload as
        | PolicyEventPayloads['policy.rule.amended']
        | PolicyEventPayloads['policy.rule.revoked'];
      writeRule(db, rule, 0, false);
      setPolicyVersion(db, workspaceId, policyVersion);
      return;
    }
    case 'policy.proposal.created': {
      const { proposal } =
        event.payload as PolicyEventPayloads['policy.proposal.created'];
      writeProposal(db, proposal, true);
      return;
    }
    case 'policy.proposal.resolved': {
      const { proposal } =
        event.payload as PolicyEventPayloads['policy.proposal.resolved'];
      writeProposal(db, proposal, false);
      return;
    }
    default:
      throw new Error(`Unknown policy event ${event.type}`);
  }
}

/** Clears the authority projection of one workspace, before a rebuild replays its events. */
export function clearPolicyProjection(
  db: SqlDatabase,
  workspaceId: string,
): void {
  db.run('DELETE FROM policy_proposals WHERE workspace_id = ?', [workspaceId]);
  db.run('DELETE FROM policy_rules WHERE workspace_id = ?', [workspaceId]);
  db.run('DELETE FROM policy_state WHERE workspace_id = ?', [workspaceId]);
}

interface ProposalRow {
  workspace_id: string;
  id: string;
  status: string;
  action: string;
  resource: string;
  scope: string;
  max_risk: string;
  grantee_kind: string;
  limits_json: string;
  evidence_json: string;
  approvals: number;
  created_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution_note: string | null;
  resulting_rule_id: string | null;
}

const PROPOSAL_COLUMNS =
  'workspace_id, id, status, action, resource, scope, max_risk, grantee_kind, limits_json, evidence_json, approvals, created_at, resolved_at, resolved_by, resolution_note, resulting_rule_id';

function toProposal(row: ProposalRow): PolicyProposal {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    status: row.status as ProposalStatus,
    action: row.action,
    resource: row.resource,
    scope: row.scope,
    maxRisk: row.max_risk as Risk,
    granteeKind: row.grantee_kind as PrincipalKind,
    limits: JSON.parse(row.limits_json) as RuleLimits,
    evidence: JSON.parse(row.evidence_json) as string[],
    approvals: row.approvals,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    resolutionNote: row.resolution_note,
    resultingRuleId: row.resulting_rule_id,
  };
}

export function loadProposals(
  db: SqlDatabase,
  workspaceId: string,
  status?: ProposalStatus,
): PolicyProposal[] {
  return db
    .all<ProposalRow>(
      `SELECT ${PROPOSAL_COLUMNS} FROM policy_proposals WHERE workspace_id = ?${status === undefined ? '' : ' AND status = ?'} ORDER BY created_at, id`,
      status === undefined ? [workspaceId] : [workspaceId, status],
    )
    .map(toProposal);
}

export function loadProposal(
  db: SqlDatabase,
  workspaceId: string,
  id: string,
): PolicyProposal | undefined {
  const row = db.get<ProposalRow>(
    `SELECT ${PROPOSAL_COLUMNS} FROM policy_proposals WHERE workspace_id = ? AND id = ?`,
    [workspaceId, id],
  );
  return row === undefined ? undefined : toProposal(row);
}

interface PreferenceRow {
  key: string;
  value_json: string;
  version: number;
  updated_by: string;
  updated_at: string;
}

export function loadPreferences(
  db: SqlDatabase,
  workspaceId: string,
): Preference[] {
  return db
    .all<PreferenceRow>(
      'SELECT key, value_json, version, updated_by, updated_at FROM preferences WHERE workspace_id = ? ORDER BY key',
      [workspaceId],
    )
    .map((row) => ({
      key: row.key,
      value: JSON.parse(row.value_json) as unknown,
      version: row.version,
      updatedBy: row.updated_by,
      updatedAt: row.updated_at,
    }));
}

interface ReceiptRow {
  seq: number;
  principal_id: string;
  action: string;
  resource: string;
  scope: string;
  risk: string;
  amount: number | null;
  mission_id: string | null;
  effect: string;
  code: string;
  reason: string;
  rule_id: string | null;
  rule_version: number | null;
  policy_version: number;
  evaluated_at: string;
}

export function loadReceipts(
  db: SqlDatabase,
  workspaceId: string,
  afterSeq: number,
  limit: number,
): PolicyReceipt[] {
  return db
    .all<ReceiptRow>(
      `SELECT seq, principal_id, action, resource, scope, risk, amount, mission_id, effect, code, reason, rule_id, rule_version, policy_version, evaluated_at
       FROM policy_receipts WHERE workspace_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
      [workspaceId, afterSeq, limit],
    )
    .map((row) => ({
      seq: row.seq,
      principalId: row.principal_id,
      action: row.action,
      resource: row.resource,
      scope: row.scope,
      risk: row.risk as Risk,
      amount: row.amount,
      missionId: row.mission_id,
      effect: row.effect as 'deny' | 'escalate',
      code: row.code as PolicyReceipt['code'],
      reason: row.reason,
      ruleId: row.rule_id,
      ruleVersion: row.rule_version,
      policyVersion: row.policy_version,
      evaluatedAt: row.evaluated_at,
    }));
}
