import type { PrincipalKind } from '../auth/principals.js';
import type { Risk } from '../core/types.js';

export const RULE_EFFECTS = ['allow', 'deny'] as const;
export type RuleEffect = (typeof RULE_EFFECTS)[number];

/** Only `allow` permits an effect. `escalate` is a refusal that a person or delegate may still settle. */
export type EvaluationEffect = 'allow' | 'deny' | 'escalate';

export type EvaluationCode =
  | 'granted'
  | 'safe_cleanup'
  | 'explicit_deny'
  | 'no_matching_grant'
  | 'sensitive_requires_explicit_grant'
  | 'amount_required'
  | 'grant_expired'
  | 'grant_revoked'
  | 'producer_cannot_review'
  | 'unknown_principal'
  | 'principal_disabled';

export interface Grantee {
  kind: PrincipalKind | null;
  principalId: string | null;
}

export interface RuleLimits {
  /** Largest `amount` one effect may carry. A grant without it covers no request that carries an amount. */
  maxAmount: number | null;
  /** The grant covers only these missions. */
  missionIds: string[] | null;
}

export interface PolicyRule {
  id: string;
  workspaceId: string;
  /** Moves on every amendment and on revocation. */
  version: number;
  effect: RuleEffect;
  action: string;
  resource: string;
  scope: string;
  /** Highest risk an allow rule covers. A deny rule applies at every risk. */
  maxRisk: Risk;
  grantee: Grantee;
  limits: RuleLimits;
  note: string | null;
  expiresAt: string | null;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
  revokeReason: string | null;
  sourceProposalId: string | null;
  /** `events.seq` of the creating event. Orders rules deterministically. */
  createdSeq: number;
}

export interface AuthorizeRequest {
  /** Workspace id. */
  workspace: string;
  /** The principal asking. Its kind is read from the store, never from the caller. */
  principal: string | { id: string };
  action: string;
  resource: string;
  scope: string;
  risk: Risk;
  amount?: number | undefined;
  missionId?: string | undefined;
  /** Principals known to have produced the work, in addition to those the mission records. */
  producerIds?: readonly string[] | undefined;
}

/** The verdict for one request, and the policy version and rule it came from. */
export interface PolicyEvaluation {
  effect: EvaluationEffect;
  code: EvaluationCode;
  reason: string;
  /** The rule that decided, or the rule that would have but was expired or revoked. */
  ruleId: string | null;
  ruleVersion: number | null;
  /** The workspace's policy version when this was evaluated. */
  policyVersion: number;
  /** Store this as the event `policyRef`. */
  policyRef: string;
  evaluatedAt: string;
}

export interface PolicyReceipt {
  seq: number;
  principalId: string;
  action: string;
  resource: string;
  scope: string;
  risk: Risk;
  amount: number | null;
  missionId: string | null;
  effect: 'deny' | 'escalate';
  code: EvaluationCode;
  reason: string;
  ruleId: string | null;
  ruleVersion: number | null;
  policyVersion: number;
  evaluatedAt: string;
}

export interface Preference {
  key: string;
  value: unknown;
  version: number;
  updatedBy: string;
  updatedAt: string;
}

export const PROPOSAL_STATUSES = [
  'pending',
  'accepted',
  'narrowed',
  'declined',
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

/** A standing rule Tower suggests after repeated approvals. It authorizes nothing until a human accepts it. */
export interface PolicyProposal {
  id: string;
  workspaceId: string;
  status: ProposalStatus;
  action: string;
  resource: string;
  scope: string;
  maxRisk: Risk;
  granteeKind: PrincipalKind;
  limits: RuleLimits;
  /** Decision ids whose approvals led here. */
  evidence: string[];
  approvals: number;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
  resultingRuleId: string | null;
}

/** An approved request, as the Decision Inbox reports it to the policy store. */
export interface ApprovalObservation {
  decisionId: string;
  action: string;
  resource: string;
  scope: string;
  risk: Risk;
  amount: number | null;
  approvedBy: string;
  at: string;
}

export interface HistoryItem {
  version: number;
  seq: number;
  type: string;
  actorId: string;
  correlationId: string;
  recordedAt: string;
  payload: unknown;
}

export interface HistoryPage {
  items: HistoryItem[];
  /** Pass as `afterVersion` to read the next page, or null at the end. */
  nextAfterVersion: number | null;
}
