// Core domain vocabulary. See docs/GLOSSARY.md for definitions.

export type Risk = 'low' | 'medium' | 'high' | 'critical';
export const RISK_ORDER: Record<Risk, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export type PrincipalKind = 'human' | 'chief' | 'runner' | 'provider' | 'system';

export interface Principal {
  id: string;
  workspaceId: string;
  kind: PrincipalKind;
  name: string;
  scopes: string[];
  status: 'active' | 'revoked';
}

/** Who is acting, under which correlation id. Every transition records both. */
export interface Actor {
  principal: Principal;
  correlationId: string;
}

// ---------- Missions ----------

export type MissionState =
  | 'draft'
  | 'active'
  | 'paused'
  | 'verifying'
  | 'reconciling'
  | 'completed'
  | 'needs_attention'
  | 'cancelled';

/** Derived, explanatory sub-status of an active mission. Not authoritative. */
export type MissionActivity =
  | 'planning'
  | 'queued'
  | 'running'
  | 'waiting_runner'
  | 'waiting_decision'
  | 'waiting_dependency'
  | 'waiting_external'
  | 'verification_pending'
  | 'idle'
  | 'done';

export interface DodItem {
  id: string;
  text: string;
  done: boolean;
  evidenceId?: string;
}

/** The owner-approved authority envelope for a mission (tier 1 scope). */
export interface AuthorityEnvelope {
  actions: string[];
  resources: string[];
}

export interface Blocker {
  kind: 'decision' | 'runner' | 'dependency' | 'external' | 'review' | 'verification' | 'policy' | 'recovery';
  ref?: string;
  packetId?: string;
  reason: string;
}

export interface Discrepancy {
  id: string;
  linkId?: string;
  kind: 'reopened' | 'drift' | 'close_failed' | 'readback_mismatch' | 'provider_error' | 'missing_evidence';
  detail: string;
  detectedAt: string;
  resolvedAt?: string;
}

export interface MissionVerification {
  verdict: 'pass' | 'fail';
  by: string;
  byKind: PrincipalKind;
  evidenceIds: string[];
  note?: string;
  at: string;
  independent: boolean;
}

export interface Mission {
  id: string;
  workspaceId: string;
  parentId: string | null;
  title: string;
  intent: string;
  outcome: string;
  constraints: string[];
  risks: string[];
  risk: Risk;
  size: string;
  dod: DodItem[];
  acceptance: string[];
  authority: AuthorityEnvelope;
  priority: number;
  source: string;
  createdBy: string;
  state: MissionState;
  activity: MissionActivity;
  blockers: Blocker[];
  dependsOn: string[];
  verification: MissionVerification | null;
  discrepancies: Discrepancy[];
  policyVersionRef: number;
  version: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

// ---------- Work packets & attempts ----------

export type PacketState =
  | 'pending' // dependencies not yet done
  | 'ready' // eligible for dispatch
  | 'leased' // claimed, runner preparing
  | 'running'
  | 'recovering' // runner lost; waiting for reconnection or portable checkpoint
  | 'held' // waiting on a decision or chief of staff; only this branch stops
  | 'review_pending' // executor reported success but required gates are unmet
  | 'done'
  | 'failed'
  | 'paused'
  | 'cancelled';

export interface PacketScope {
  repo?: string;
  branch?: string;
  paths?: string[];
  issueUrls?: string[];
}

export interface Checkpoint {
  portable: boolean;
  kind: 'branch' | 'artifact' | 'none';
  ref?: string;
  sha?: string;
  note?: string;
  at: string;
}

export interface GateResult {
  passed: boolean;
  reasons: string[];
  checkedAt: string;
}

export interface Packet {
  id: string;
  workspaceId: string;
  missionId: string;
  title: string;
  goal: string;
  scope: PacketScope;
  acceptance: string[];
  engine: string;
  capabilities: string[];
  risk: Risk;
  reviewRequired: boolean;
  dependsOn: string[];
  kind: 'work' | 'integration';
  origin: 'planned' | 'followup' | 'expansion';
  state: PacketState;
  holdReason: string | null;
  blockedBy: string[];
  execScope: string;
  currentAttemptId: string | null;
  attemptsCount: number;
  maxAttempts: number;
  nextEligibleAt: string | null;
  checkpoint: Checkpoint | null;
  result: unknown;
  gate: GateResult | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export type AttemptState =
  | 'leased'
  | 'running'
  | 'lost' // lease expired without heartbeat
  | 'succeeded'
  | 'failed'
  | 'fenced' // superseded by a newer holder of the same execution scope
  | 'cancelled';

export type FailureClass =
  | 'environment'
  | 'runner'
  | 'adapter'
  | 'quota'
  | 'policy_denial'
  | 'review_failure'
  | 'implementation_defect'
  | 'cancelled'
  | 'unknown';

export interface Attempt {
  id: string;
  workspaceId: string;
  packetId: string;
  missionId: string;
  runnerId: string;
  execScope: string;
  fence: number;
  leaseExpiresAt: string;
  state: AttemptState;
  contract: unknown;
  localRunId: string | null;
  phase: string | null;
  checkpoint: Checkpoint | null;
  receipt: unknown;
  failureClass: FailureClass | null;
  failureDetail: string | null;
  control: 'cancel' | 'pause' | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

// ---------- Runners ----------

export type RunnerStatus = 'online' | 'offline' | 'quarantined' | 'draining';

export interface Runner {
  id: string;
  workspaceId: string;
  principalId: string;
  name: string;
  clientVersion: string | null;
  platform: string | null;
  engines: string[];
  capabilities: string[];
  allowedScopes: string[];
  maxConcurrency: number;
  status: RunnerStatus;
  quarantineReason: string | null;
  lastSeenAt: string | null;
  version: number;
  createdAt: string;
}

// ---------- Decisions ----------

export interface Alternative {
  id: string;
  label: string;
  consequence?: string;
}

export interface RequiredAuthority {
  action: string;
  resource: string;
  risk: Risk;
}

/** What Tower applies when a decision is approved. */
export interface OnApprove {
  extendAuthority?: AuthorityEnvelope;
  createPacket?: NewPacketInput;
  releasePackets?: boolean;
}

export interface Decision {
  id: string;
  workspaceId: string;
  missionId: string;
  category: string;
  urgency: 'low' | 'normal' | 'high' | 'urgent';
  audience: 'chief' | 'human';
  question: string;
  alternatives: Alternative[];
  recommendation: { alternativeId: string; rationale: string; by: string } | null;
  consequences: string;
  requiredAuthority: RequiredAuthority;
  evidence: string[];
  affectedScope: string;
  onApprove: OnApprove;
  dedupeKey: string;
  status: 'open' | 'answered' | 'withdrawn';
  answer: { approved: boolean; alternativeId?: string; note?: string } | null;
  answeredBy: string | null;
  answeredAt: string | null;
  ruleRef: { ruleId: string; policyVersion: number } | null;
  linkedPackets: string[];
  version: number;
  createdAt: string;
}

// ---------- Policy ----------

export type Grantee = 'chief' | 'runner' | 'tower' | 'any';

export interface RuleConditions {
  maxRisk?: Risk;
  maxUses?: number;
  missionIds?: string[];
}

export interface PolicyRule {
  id: string;
  workspaceId: string;
  effect: 'allow' | 'deny';
  action: string;
  resource: string;
  grantee: Grantee;
  conditions: RuleConditions;
  status: 'active' | 'revoked';
  expiresAt: string | null;
  uses: number;
  supersedes: string | null;
  source: 'explicit' | 'proposal';
  createdBy: string;
  createdAt: string;
  createdPolicyVersion: number;
  revokedBy: string | null;
  revokedAt: string | null;
  note: string;
  version: number;
}

export interface PolicyRequest {
  grantee: Grantee;
  action: string;
  resource: string;
  risk: Risk;
  missionId?: string;
}

export interface PolicyEvaluation {
  allowed: boolean;
  basis: 'envelope' | 'rule' | 'deny_rule' | 'default_deny' | 'halted' | 'sensitive_default_deny';
  ruleId?: string;
  policyVersion: number;
  reason: string;
}

// ---------- Issue links ----------

export type LinkRole = 'required' | 'optional' | 'reference';
export type ObservedIssueState = 'open' | 'closed' | 'unknown';

export interface IssueLink {
  id: string;
  workspaceId: string;
  missionId: string;
  url: string;
  provider: string;
  externalRef: string | null;
  role: LinkRole;
  titleSnapshot: string | null;
  descriptionSnapshot: string | null;
  observedState: ObservedIssueState;
  observedAt: string | null;
  observedSource: string | null;
  exemption: { by: string; reason: string; at: string } | null;
  lastError: string | null;
  errorCount: number;
  version: number;
  createdAt: string;
}

// ---------- Inputs ----------

export interface NewPacketInput {
  title: string;
  goal: string;
  scope?: PacketScope;
  acceptance?: string[];
  engine?: string;
  capabilities?: string[];
  risk?: Risk;
  reviewRequired?: boolean;
  dependsOn?: string[];
  kind?: 'work' | 'integration';
  maxAttempts?: number;
}
