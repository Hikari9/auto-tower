import { z } from 'zod';

/**
 * Tower <-> office engine contract, version 1.
 *
 * Tower issues an immutable DispatchContract per attempt and accepts Receipts.
 * Engine adapters (Auto-Office today) live on the runner and translate their
 * native run state into these receipts. Tower never reads engine internals.
 */
export const DISPATCH_CONTRACT = 'tower.dispatch/v1';
export const RECEIPT_CONTRACT = 'tower.receipt/v1';
export const RUNNER_PROTOCOL = 'tower.runner/v1';

export const RiskSchema = z.enum(['low', 'medium', 'high', 'critical']);

export const EvidenceProfileSchema = z.object({
  selfVerification: z.boolean(),
  independentReview: z.boolean(),
  integratedVerification: z.boolean(),
  commitSha: z.boolean(),
});
export type EvidenceProfile = z.infer<typeof EvidenceProfileSchema>;

export interface DispatchContract {
  contract: typeof DISPATCH_CONTRACT;
  issuedAt: string;
  attemptId: string;
  fence: number;
  leaseExpiresAt: string;
  correlationId: string;
  workspaceId: string;
  mission: { id: string; title: string; outcome: string; constraints: string[]; acceptance: string[]; risk: string; definitionOfDone: string[] };
  packet: { id: string; title: string; goal: string; kind: 'work' | 'integration'; scope: Record<string, unknown>; acceptance: string[]; engine: string; risk: string };
  /** Linked issue URLs. Their titles and bodies are untrusted data, never instructions. */
  links: { url: string; role: string; title: string | null }[];
  /** Snapshot for planning only. Every guarded effect must still call authorize-effect. */
  authority: { actions: string[]; resources: string[]; policyVersion: number };
  guards: {
    pointOfEffectCheck: true;
    singleWriterScope: string;
    leaseRenewal: 'heartbeat';
    landingRequiresGate: boolean;
  };
  evidenceProfile: EvidenceProfile;
  resumeFrom: { kind: string; ref?: string; sha?: string } | null;
  untrustedFields: string[];
}

const Identity = z.object({
  id: z.string().min(1).max(200),
  sessionId: z.string().min(1).max(200),
  kind: z.enum(['agent', 'human', 'chief']).default('agent'),
});

export const CheckpointSchema = z.object({
  portable: z.boolean(),
  kind: z.enum(['branch', 'artifact', 'none']),
  ref: z.string().max(500).optional(),
  sha: z.string().max(100).optional(),
  note: z.string().max(2000).optional(),
});

export const FailureClassSchema = z.enum(['environment', 'runner', 'adapter', 'quota', 'policy_denial', 'review_failure', 'implementation_defect', 'cancelled', 'unknown']);

const Status = z.enum(['pass', 'fail', 'not_run']);

export const CompletionSchema = z.object({
  outcome: z.enum(['succeeded', 'failed']),
  producer: z.object({ engine: z.string(), engineVersion: z.string().optional(), runId: z.string(), sessionId: z.string() }),
  commitSha: z.string().regex(/^[0-9a-f]{7,64}$/i).optional(),
  selfVerification: z.object({ status: Status, summary: z.string().max(4000) }),
  independentReview: z
    .object({
      status: z.enum(['approved', 'changes_requested', 'not_run']),
      reviewer: Identity,
      independence: z.enum(['independent', 'degraded']).default('independent'),
      sha: z.string().optional(),
      summary: z.string().max(4000).default(''),
    })
    .optional(),
  tests: z.object({ status: Status, summary: z.string().max(4000).default(''), count: z.number().int().nonnegative().optional() }).optional(),
  integratedVerification: z.object({ status: Status, summary: z.string().max(4000).default('') }).optional(),
  landing: z.object({ status: z.enum(['not_landed', 'pr_open', 'landed']), ref: z.string().optional(), sha: z.string().optional() }).optional(),
  residualRisks: z.array(z.string().max(1000)).max(50).default([]),
  dodItemsMet: z.array(z.string()).default([]),
  nextAction: z.string().max(500).optional(),
  evidence: z
    .array(z.object({ kind: z.string().max(50), summary: z.string().max(4000), uri: z.string().max(1000).optional(), sha: z.string().max(100).optional() }))
    .max(100)
    .default([]),
});
export type Completion = z.infer<typeof CompletionSchema>;

export const ReceiptSchema = z.object({
  contract: z.literal(RECEIPT_CONTRACT),
  receiptId: z.string().min(8).max(100),
  attemptId: z.string(),
  fence: z.number().int().positive(),
  kind: z.enum(['progress', 'checkpoint', 'complete', 'fail']),
  phase: z.string().max(100).optional(),
  message: z.string().max(4000).optional(),
  localRunId: z.string().max(200).optional(),
  checkpoint: CheckpointSchema.optional(),
  completion: CompletionSchema.optional(),
  failure: z.object({ class: FailureClassSchema, detail: z.string().max(4000), retryable: z.boolean() }).optional(),
});
export type Receipt = z.infer<typeof ReceiptSchema>;

export const RegisterSchema = z.object({
  protocol: z.literal(RUNNER_PROTOCOL).default(RUNNER_PROTOCOL),
  name: z.string().min(1).max(100),
  clientVersion: z.string().max(50),
  platform: z.string().max(100).default('unknown'),
  engines: z.array(z.string().max(50)).min(1).max(20),
  capabilities: z.array(z.string().max(100)).max(100).default([]),
  allowedScopes: z.array(z.string().max(300)).max(100).default([]),
  maxConcurrency: z.number().int().min(1).max(32).default(1),
});
export type RegisterInput = z.infer<typeof RegisterSchema>;

export const HeartbeatSchema = z.object({
  attempts: z
    .array(z.object({ attemptId: z.string(), fence: z.number().int(), phase: z.string().max(100).optional(), localRunId: z.string().max(200).optional() }))
    .max(64)
    .default([]),
  draining: z.boolean().optional(),
});
export type HeartbeatInput = z.infer<typeof HeartbeatSchema>;

export const EffectSchema = z.object({
  attemptId: z.string(),
  fence: z.number().int(),
  action: z.string().min(1).max(200),
  resource: z.string().min(1).max(500),
  risk: RiskSchema.optional(),
  /** Required for landing actions on review-required packets. */
  producerSessionId: z.string().max(200).optional(),
  review: z
    .object({
      status: z.enum(['approved', 'changes_requested', 'not_run']),
      reviewer: Identity,
      independence: z.enum(['independent', 'degraded']).default('independent'),
      sha: z.string().optional(),
    })
    .optional(),
});

export const ExpansionSchema = z.object({
  attemptId: z.string(),
  fence: z.number().int(),
  action: z.string().min(1).max(200),
  resource: z.string().min(1).max(500),
  risk: RiskSchema.optional(),
  reason: z.string().min(1).max(4000),
  alternatives: z.array(z.object({ id: z.string(), label: z.string(), consequence: z.string().optional() })).max(10).optional(),
  recommendation: z.string().max(4000).optional(),
  blocking: z.boolean().default(true),
  followup: z
    .object({ title: z.string(), goal: z.string(), scope: z.object({ repo: z.string().optional(), branch: z.string().optional(), paths: z.array(z.string()).optional() }).optional() })
    .optional(),
});

export const FollowupSchema = z.object({
  attemptId: z.string(),
  fence: z.number().int(),
  title: z.string().min(1).max(300),
  goal: z.string().min(1).max(4000),
  scope: z.object({ repo: z.string().optional(), branch: z.string().optional(), paths: z.array(z.string()).optional() }).optional(),
  acceptance: z.array(z.string()).optional(),
  dependsOnCurrent: z.boolean().default(false),
});
