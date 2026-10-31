export const MISSION_STATUSES = [
  'draft',
  'planning',
  'ready',
  'running',
  'waiting-runner',
  'waiting-decision',
  'waiting-external',
  'verifying',
  'reconciling',
  'completed',
  'needs-attention',
  'cancelled',
] as const;
export type MissionStatus = (typeof MISSION_STATUSES)[number];

export const PACKET_STATUSES = [
  'pending',
  'ready',
  'leased',
  'running',
  'reported',
  'verified',
  'failed',
  'cancelled',
] as const;
export type PacketStatus = (typeof PACKET_STATUSES)[number];

export const ATTEMPT_STATUSES = [
  'leased',
  'running',
  'self-reported-succeeded',
  'self-reported-failed',
  'cancelled',
] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export const RISKS = ['low', 'medium', 'high'] as const;
export type Risk = (typeof RISKS)[number];

export const SIZES = ['xs', 's', 'm', 'l', 'xl'] as const;
export type Size = (typeof SIZES)[number];

export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const LINK_CLASSIFICATIONS = [
  'required',
  'optional',
  'reference-only',
] as const;
export type LinkClassification = (typeof LINK_CLASSIFICATIONS)[number];

export interface DoneItem {
  text: string;
  done: boolean;
}

/** A stored link to external work. It carries no write access and is never fetched by the core. */
export interface IssueLinkRef {
  url: string;
  classification: LinkClassification;
  title: string | null;
}

export interface Verification {
  at: string;
  by: string;
  evidenceRefs: string[];
}

export interface Authorization {
  at: string;
  by: string;
  policyRefs: string[];
}

export interface WorkPacket {
  id: string;
  missionId: string;
  position: number;
  title: string;
  instructions: string;
  scope: string[];
  required: boolean;
  status: PacketStatus;
  dependsOn: string[];
  authorization: Authorization | null;
  /** Set only by Tower's own verification, never by a runner's report. */
  verification: Verification | null;
  activeAttemptId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AttemptReport {
  outcome: 'succeeded' | 'failed';
  summary: string | null;
  by: string;
}

export interface ExecutionAttempt {
  id: string;
  missionId: string;
  packetId: string;
  number: number;
  runnerId: string;
  status: AttemptStatus;
  dispatchedAt: string;
  startedAt: string | null;
  reportedAt: string | null;
  /** What the runner claimed. Not verified. */
  report: AttemptReport | null;
}

export interface MissionState {
  id: string;
  workspaceId: string;
  /** Version of the mission's event stream this state was built from. */
  version: number;
  state: MissionStatus;
  title: string;
  intent: string;
  outcome: string;
  constraints: string[];
  risk: Risk;
  size: Size;
  priority: Priority;
  definitionOfDone: DoneItem[];
  source: string;
  createdBy: string;
  parentId: string | null;
  requiredForParent: boolean;
  links: IssueLinkRef[];
  /** References to the authority policy versions the mission runs under. */
  policyRefs: string[];
  /** Every evidence ref recorded on any event of the mission, in first-seen order. */
  evidenceRefs: string[];
  outcomeVerification: Verification | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
  packets: WorkPacket[];
  attempts: ExecutionAttempt[];
}

export interface Actor {
  id: string;
  kind: 'human' | 'chief_of_staff' | 'runner' | 'provider_adapter';
}

export const missionStreamId = (missionId: string): string =>
  `mission:${missionId}`;
