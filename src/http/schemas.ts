import { z } from 'zod';
import { RiskSchema } from '../contracts/office-v1.ts';

const str = (max = 500) => z.string().trim().min(1).max(max);
const Envelope = z.object({ actions: z.array(str(200)).max(100), resources: z.array(str(500)).max(100) });
const Scope = z.object({ repo: str(200).optional(), branch: str(200).optional(), paths: z.array(str(500)).max(100).optional(), issueUrls: z.array(str(2048)).max(50).optional() });
const Role = z.enum(['required', 'optional', 'reference']);

export const PacketInput = z.object({
  title: str(300),
  goal: str(8000),
  scope: Scope.optional(),
  acceptance: z.array(str(1000)).max(50).optional(),
  engine: str(50).optional(),
  capabilities: z.array(str(100)).max(50).optional(),
  risk: RiskSchema.optional(),
  reviewRequired: z.boolean().optional(),
  dependsOn: z.array(str(100)).max(50).optional(),
  dependsOnIndex: z.array(z.number().int().nonnegative()).max(50).optional(),
  kind: z.enum(['work', 'integration']).optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
});

export const LinkInput = z.object({ url: str(2048), role: Role.optional(), title: z.string().max(300).optional(), description: z.string().max(8000).optional() });

export const MissionCreate = z.object({
  title: str(300),
  intent: z.string().max(8000).default(''),
  outcome: str(4000),
  constraints: z.array(str(1000)).max(50).optional(),
  risks: z.array(str(1000)).max(50).optional(),
  risk: RiskSchema.optional(),
  size: z.enum(['xs', 's', 'm', 'l', 'xl']).optional(),
  definitionOfDone: z.array(str(1000)).max(50).optional(),
  acceptance: z.array(str(1000)).max(50).optional(),
  authority: Envelope.optional(),
  priority: z.number().int().min(0).max(100).optional(),
  parentId: str(100).optional(),
  dependsOn: z.array(str(100)).max(50).optional(),
  links: z.array(LinkInput).max(50).optional(),
  packets: z.array(PacketInput).max(50).optional(),
  start: z.boolean().optional(),
});

export const MissionPatch = z.object({
  expectedVersion: z.number().int().nonnegative(),
  title: str(300).optional(),
  outcome: str(4000).optional(),
  priority: z.number().int().min(0).max(100).optional(),
  constraints: z.array(str(1000)).max(50).optional(),
  risks: z.array(str(1000)).max(50).optional(),
  acceptance: z.array(str(1000)).max(50).optional(),
  dodDone: z.array(z.object({ id: str(50), done: z.boolean(), evidenceId: str(100).optional() })).max(50).optional(),
  addDod: z.array(str(1000)).max(50).optional(),
  dependsOn: z.array(str(100)).max(50).optional(),
});

export const Verify = z.object({ verdict: z.enum(['pass', 'fail']), note: z.string().max(4000).optional(), evidenceIds: z.array(str(100)).max(50).optional() });
export const Reason = z.object({ reason: z.string().max(2000).default('') });
export const Answer = z.object({ approved: z.boolean(), alternativeId: str(100).optional(), note: z.string().max(4000).optional() });

export const RaiseDecision = z.object({
  packetIds: z.array(str(100)).max(20).optional(),
  category: str(50),
  urgency: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  audience: z.enum(['chief', 'human']).optional(),
  question: str(2000),
  alternatives: z.array(z.object({ id: str(100), label: str(300), consequence: z.string().max(2000).optional() })).max(10).optional(),
  recommendation: z.object({ alternativeId: str(100), rationale: str(4000), by: str(200) }).optional(),
  consequences: z.string().max(4000).optional(),
  requiredAuthority: z.object({ action: str(200), resource: str(500), risk: RiskSchema }),
  evidence: z.array(str(100)).max(50).optional(),
  affectedScope: z.string().max(500).optional(),
  dedupeKey: str(300).optional(),
});

const Conditions = z.object({ maxRisk: RiskSchema.optional(), maxUses: z.number().int().positive().optional(), missionIds: z.array(str(100)).max(50).optional() });
export const Grant = z.object({
  effect: z.enum(['allow', 'deny']).optional(),
  action: str(200),
  resource: str(500),
  grantee: z.enum(['chief', 'runner', 'tower', 'any']).optional(),
  conditions: Conditions.optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  note: z.string().max(2000).optional(),
});
export const Amend = Grant.partial();
export const Propose = Grant.extend({ evidence: z.array(str(100)).max(50).optional() });

export const IssueToken = z.object({ kind: z.enum(['human', 'chief', 'runner']), name: str(100), scopes: z.array(str(50)).max(20).optional() });
export const Halt = z.object({ halted: z.boolean(), reason: z.string().max(2000).default('') });
export const Attest = z.object({ state: z.enum(['open', 'closed']), note: z.string().max(2000).default('') });
export const SetRole = z.object({ role: Role });
export const Integration = z.object({ config: z.record(z.string(), z.unknown()), enabled: z.boolean().default(true) });
export const Quarantine = z.object({ reason: str(2000) });
