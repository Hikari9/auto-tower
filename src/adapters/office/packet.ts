import type { Resume } from '../../runner/protocol.js';
import { OFFICE_CONTRACT_ID } from './contract.js';

/**
 * The work packet Tower sends to an Office run (`tower.office.v1`). Fields the runner's assignment
 * does not carry are fixed here, and say so: `policyRefs` is empty and `evidenceProfile` is the
 * standard profile. The high-risk gate is enforced at mission completion, not by Office.
 */
export interface OfficePacket {
  contract: typeof OFFICE_CONTRACT_ID;
  kind: 'work-packet';
  /** The attempt id. Office echoes it back, so a receipt for another attempt is refused. */
  correlationId: string;
  missionId: string;
  packetId: string;
  attemptId: string;
  leaseId: string;
  fence: number;
  scopeKey: string;
  title: string;
  outcome: string;
  intent: string;
  constraints: string[];
  instructions: string;
  scope: string[];
  policyRefs: string[];
  evidenceProfile: 'standard';
  resume: Resume;
}

/** What the runner knows about one lease. Mirrors the runner's engine job. */
export interface PacketSource {
  missionId: string;
  packetId: string;
  attemptId: string;
  leaseId: string;
  fence: number;
  scopeKey: string;
  packet: { title: string; instructions: string; scope: string[] };
  mission: { intent: string; outcome: string; constraints: string[] };
  resume: Resume;
}

export function buildOfficePacket(source: PacketSource): OfficePacket {
  return {
    contract: OFFICE_CONTRACT_ID,
    kind: 'work-packet',
    correlationId: source.attemptId,
    missionId: source.missionId,
    packetId: source.packetId,
    attemptId: source.attemptId,
    leaseId: source.leaseId,
    fence: source.fence,
    scopeKey: source.scopeKey,
    title: source.packet.title,
    outcome: source.mission.outcome,
    intent: source.mission.intent,
    constraints: [...source.mission.constraints],
    instructions: source.packet.instructions,
    scope: [...source.packet.scope],
    policyRefs: [],
    evidenceProfile: 'standard',
    resume: source.resume,
  };
}
