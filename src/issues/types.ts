export const SYNC_MODES = ['link-only', 'observe', 'bidirectional'] as const;
export type SyncMode = (typeof SYNC_MODES)[number];

export interface SyncConfig {
  provider: string;
  /** `owner/name` lower-case, or `*` for the workspace default. */
  repo: string;
  mode: SyncMode;
  /** Whether Tower may read this repository's issues. */
  readScope: boolean;
  /** Whether Tower may write. A write also needs a Tower `authorize` allow. */
  writeScope: boolean;
  version: number;
  updatedBy: string;
  updatedAt: string;
}

export type ObservedState = 'unknown' | 'open' | 'closed';
export type ObservedSource = 'readback' | 'poll' | 'webhook' | 'close';

export type ExemptionStatus = 'none' | 'requested' | 'approved';

export interface IssueLinkRecord {
  id: string;
  missionId: string;
  url: string;
  provider: string | null;
  repo: string | null;
  issueNumber: number | null;
  nodeId: string | null;
  observedState: ObservedState;
  observedSource: ObservedSource | null;
  observedAt: string | null;
  /** Untrusted text from the provider. */
  observedTitle: string | null;
  /** Last time a poll tried this link. Null until the first poll. */
  polledAt: string | null;
  verifiedClosedAt: string | null;
  closedByTowerAt: string | null;
  retryNotBefore: string | null;
  exemption: {
    status: ExemptionStatus;
    reason: string | null;
    requestedBy: string | null;
    requestedAt: string | null;
    approvedBy: string | null;
    approvedAt: string | null;
  };
  createdAt: string;
  updatedAt: string;
}

export const DISCREPANCY_KINDS = [
  'close_failed',
  'read_back_mismatch',
  'permission_denied',
  'rate_limited',
  'provider_unavailable',
  'identity_mismatch',
  'blocked',
  'reopened',
  'drifted',
] as const;
export type DiscrepancyKind = (typeof DISCREPANCY_KINDS)[number];

export type DiscrepancySource = 'close' | 'verify' | 'poll' | 'webhook';

export interface Discrepancy {
  id: string;
  missionId: string;
  linkId: string;
  kind: DiscrepancyKind;
  detail: string;
  source: DiscrepancySource;
  requiresAttention: boolean;
  retryAfterSeconds: number | null;
  detectedBy: string;
  detectedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolution: string | null;
}

export interface LinkHistoryItem {
  seq: number;
  linkId: string;
  type: string;
  actorId: string;
  payload: unknown;
  recordedAt: string;
}
