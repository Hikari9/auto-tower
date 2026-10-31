import type { Completion } from '../contracts/office-v1.ts';
import { RISK_ORDER } from './types.ts';
import type { GateResult, Packet } from './types.ts';

export interface ReviewClaim {
  status: 'approved' | 'changes_requested' | 'not_run';
  reviewer: { id: string; sessionId: string; kind: 'agent' | 'human' | 'chief' };
  independence: 'independent' | 'degraded';
  sha?: string | undefined;
}

/**
 * Independent review rules shared by the completion gate and landing checks.
 * Permission to act and quality approval are different gates: a Chief of Staff
 * grant never counts as review, and a producer cannot review its own work.
 */
export function reviewProblems(review: ReviewClaim | undefined, producerSessionId: string, sha?: string): string[] {
  if (!review || review.status === 'not_run') return ['required independent review has not run'];
  const out: string[] = [];
  if (review.status !== 'approved') out.push(`independent review is ${review.status}`);
  if (review.independence !== 'independent') out.push('review was not independent of the producer');
  if (review.reviewer.sessionId === producerSessionId) out.push('the producing session cannot approve its own work');
  if (review.reviewer.kind === 'chief') out.push('a Chief of Staff approval is permission to act, not independent review');
  if (sha && review.sha && review.sha !== sha) out.push(`review covers ${review.sha}, not ${sha}`);
  return out;
}

/** Decide whether an executor's success receipt satisfies the packet's evidence profile. */
export function evaluateGate(packet: Packet, c: Completion, now: string): GateResult {
  const reasons: string[] = [];
  if (c.outcome !== 'succeeded') reasons.push('executor reported failure');
  if (c.selfVerification.status !== 'pass') reasons.push(`self-verification is ${c.selfVerification.status}`);
  if (c.tests?.status === 'fail') reasons.push('tests failed');
  if (packet.scope.repo && !c.commitSha) reasons.push('missing commit SHA for repository work');
  const needsReview = packet.reviewRequired || RISK_ORDER[packet.risk] >= RISK_ORDER.high;
  if (needsReview) reasons.push(...reviewProblems(c.independentReview, c.producer.sessionId, c.commitSha));
  if (packet.kind === 'integration' && c.integratedVerification?.status !== 'pass') {
    reasons.push(`integrated verification is ${c.integratedVerification?.status ?? 'missing'}`);
  }
  if (c.landing?.status === 'landed' && needsReview && c.landing.sha && c.independentReview?.sha && c.landing.sha !== c.independentReview.sha) {
    reasons.push('landed revision differs from the reviewed revision');
  }
  return { passed: reasons.length === 0, reasons, checkedAt: now };
}

/** Actions that land or ship work. They require the review gate when review is required. */
export function isLandingAction(action: string): boolean {
  return /^(land|merge|deploy)(\.|:|$)/.test(action);
}
