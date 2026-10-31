import type { Risk } from '../core/types.js';

export const DECISION_CATEGORIES = [
  'scope_expansion',
  'sensitive_action',
  'destructive',
  'spend',
  'security',
  'production',
  'novel',
  'clarification',
] as const;
export type DecisionCategory = (typeof DECISION_CATEGORIES)[number];

export const URGENCIES = ['low', 'normal', 'high', 'urgent'] as const;
export type Urgency = (typeof URGENCIES)[number];

export const REQUIRED_AUTHORITIES = ['human', 'chief_of_staff'] as const;
export type RequiredAuthority = (typeof REQUIRED_AUTHORITIES)[number];

/** One executive choice. A choice that `resumes` lets the blocked branches proceed. */
export interface Alternative {
  id: string;
  label: string;
  description: string | null;
  consequence: string | null;
  resumes: boolean;
}

export const DEFAULT_ALTERNATIVES: readonly Alternative[] = [
  {
    id: 'approve',
    label: 'Approve',
    description: null,
    consequence: null,
    resumes: true,
  },
  {
    id: 'decline',
    label: 'Decline',
    description: null,
    consequence: null,
    resumes: false,
  },
];

export interface Recommendation {
  alternativeId: string | null;
  rationale: string;
  /** Principal that made it. */
  by: string;
}

/** The action an approval would authorize, in the terms policy evaluates. */
export interface DecisionRequest {
  action: string;
  resource: string;
  scope: string;
  risk: Risk;
  amount: number | null;
}

export type LinkStatus = 'blocked' | 'resumed' | 'declined' | 'skipped';

/** A branch that waits on a decision. `packetId` is null for a link to the mission as a whole. */
export interface DecisionLink {
  missionId: string;
  packetId: string | null;
  status: LinkStatus;
  reason: string | null;
  linkedAt: string;
  resolvedAt: string | null;
  resolvedByAnswerVersion: number | null;
}

export interface DecisionAnswer {
  version: number;
  choice: string;
  note: string | null;
  answeredBy: string;
  answeredAt: string;
}

/** What the requester claims about its own request. Shown to the answerer and never evaluated. */
export interface Advisory {
  confidencePercent: number | null;
}

export interface Decision {
  id: string;
  workspaceId: string;
  /** Version of the decision's event stream. */
  version: number;
  status: 'open' | 'answered';
  dedupeKey: string;
  category: DecisionCategory;
  urgency: Urgency;
  question: string;
  alternatives: Alternative[];
  recommendation: Recommendation | null;
  consequences: string;
  requiredAuthority: RequiredAuthority;
  evidence: string[];
  affectedScope: string[];
  request: DecisionRequest | null;
  advisory: Advisory;
  createdBy: string;
  createdAt: string;
  /** The answer with the highest version, which decides the outcome. */
  effectiveAnswer: DecisionAnswer | null;
  links: DecisionLink[];
}

export interface Branch {
  missionId: string;
  packetId: string | null;
}
