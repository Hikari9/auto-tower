import type {
  EngineHooks,
  EngineJob,
  EngineResult,
  RunnerEngine,
} from '../../runner/engine.js';
import { ClassifiedFailure } from '../../runner/failure.js';
import { buildOfficePacket, type OfficePacket } from './packet.js';
import { factsOf, type OfficeReceipt } from './receipt.js';

/** Anything that runs an Office packet and returns its receipt. The CLI engine and the fake both fit. */
export interface OfficeEngine {
  run(packet: OfficePacket, hooks: EngineHooks): Promise<OfficeReceipt>;
}

const MAX_RISKS = 20;
const MAX_RISK_CHARS = 200;
const MAX_MESSAGE_CHARS = 1_000;

/**
 * The receipt as Tower stores it, with the free text capped. Tower refuses evidence over 16 KB,
 * and a receipt with 50 long residual risks would pass that bound.
 */
export function receiptEvidence(
  receipt: OfficeReceipt,
): Record<string, unknown> {
  return {
    contract: receipt.contract,
    kind: receipt.kind,
    receiptId: receipt.receiptId,
    correlationId: receipt.correlationId,
    runId: receipt.runId,
    outcome: receipt.outcome,
    executor: receipt.executor,
    selfVerification: receipt.selfVerification,
    independentReview: receipt.independentReview,
    integratedVerification: receipt.integratedVerification,
    failure:
      receipt.failure === null
        ? null
        : {
            class: receipt.failure.class,
            message: receipt.failure.message.slice(0, MAX_MESSAGE_CHARS),
          },
    residualRisks: receipt.residualRisks
      .slice(0, MAX_RISKS)
      .map((risk) => risk.slice(0, MAX_RISK_CHARS)),
  };
}

/**
 * Runs one lease through an Office engine. The packet is built from the lease, the receipt becomes
 * the runner's outcome, and a failed outcome carries the class the receipt gave it.
 */
export function officeRunnerEngine(engine: OfficeEngine): RunnerEngine {
  return {
    async run(job: EngineJob, hooks: EngineHooks): Promise<EngineResult> {
      const packet = buildOfficePacket({
        missionId: job.missionId,
        packetId: job.packetId,
        attemptId: job.attemptId,
        leaseId: job.leaseId,
        fence: job.fence,
        scopeKey: job.scopeKey,
        packet: job.packet,
        mission: job.mission,
        resume: job.resume,
      });
      const receipt = await engine.run(packet, hooks);
      if (receipt.correlationId !== packet.correlationId) {
        throw new ClassifiedFailure(
          'adapter',
          'office receipt is for another attempt',
        );
      }
      if (receipt.outcome === 'succeeded') {
        return {
          outcome: 'succeeded',
          summary: receipt.summary,
          evidence: receiptEvidence(receipt),
        };
      }
      return {
        outcome: 'failed',
        summary: receipt.summary,
        evidence: receiptEvidence(receipt),
        failureClass: factsOf(receipt, []).failureClass ?? 'adapter',
      };
    },
  };
}
