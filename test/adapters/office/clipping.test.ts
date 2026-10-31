import { describe, expect, it } from 'vitest';
import {
  factsOf,
  parseOfficeReceipt,
} from '../../../src/adapters/office/receipt.js';

const base = {
  contract: 'tower.office.v1',
  kind: 'receipt',
  receiptId: 'office.run-1',
  correlationId: 'att_1',
  runId: 'run-1',
  outcome: 'succeeded',
  executor: { id: 'exec-1' },
  selfVerification: { result: 'passed', by: 'exec-1' },
  independentReview: { reviewer: 'reviewer-2', result: 'approved' },
  integratedVerification: {
    result: 'passed',
    testsRun: 3,
    commitSha: 'a'.repeat(40),
  },
  failure: null,
};

describe('long free text is clipped, not refused', () => {
  it('keeps a completed run as a success when its summary and risk list are long', () => {
    const parsed = parseOfficeReceipt({
      ...base,
      summary: 'x'.repeat(5_000),
      residualRisks: Array.from({ length: 60 }, () => 'r'.repeat(600)),
    });
    expect(parsed.outcome).toBe('succeeded');
    expect(parsed.summary).toHaveLength(4_000);
    expect(parsed.residualRisks).toHaveLength(50);
    expect(parsed.residualRisks[0]).toHaveLength(500);
  });

  it('still refuses a summary that is not a string', () => {
    expect(() => parseOfficeReceipt({ ...base, summary: 7 })).toThrow(
      /summary/,
    );
  });
});

describe('identity folding', () => {
  it('a reviewer name with invisible characters still names the producer', () => {
    const facts = factsOf(
      parseOfficeReceipt({
        ...base,
        independentReview: { reviewer: 'exec-1​', result: 'approved' },
      }),
      ['prn_runner_1'],
    );
    expect(facts.independentReview).toBe('self-reviewed');
  });

  it('a reviewer name in another case still names the producer', () => {
    const facts = factsOf(
      parseOfficeReceipt({
        ...base,
        independentReview: { reviewer: 'EXEC-1', result: 'approved' },
      }),
      ['prn_runner_1'],
    );
    expect(facts.independentReview).toBe('self-reviewed');
  });
});

describe('identity folding composes compatibility characters', () => {
  it('a full-width reviewer name is the producer under its ordinary spelling', () => {
    const facts = factsOf(
      parseOfficeReceipt({
        ...base,
        executor: { id: 'exec-1' },
        independentReview: { reviewer: 'ＥＸＥＣ-1', result: 'approved' },
      }),
      ['prn_runner_1'],
    );
    expect(facts.independentReview).toBe('self-reviewed');
  });

  it('a Cyrillic look-alike is not folded, so it is a different identity', () => {
    const facts = factsOf(
      parseOfficeReceipt({
        ...base,
        executor: { id: 'exec-1' },
        // The Cyrillic small letter ie stands in for the Latin e in "exec".
        independentReview: { reviewer: 'еxec-1', result: 'approved' },
      }),
      ['prn_runner_1'],
    );
    expect(facts.independentReview).toBe('satisfied');
  });
});
