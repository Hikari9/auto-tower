import { describe, expect, it } from 'vitest';
import { ContractError } from '../../../src/adapters/office/contract.js';
import {
  factsOf,
  isReady,
  type OfficeReceipt,
  parseOfficeReceipt,
} from '../../../src/adapters/office/receipt.js';

const PRODUCER = 'prn_runner_1';

function receipt(overrides: Partial<OfficeReceipt> = {}): OfficeReceipt {
  return {
    contract: 'tower.office.v1',
    kind: 'receipt',
    receiptId: 'office.run-1',
    correlationId: 'att_1',
    runId: 'run-1',
    outcome: 'succeeded',
    summary: 'done',
    executor: { id: 'exec-1' },
    selfVerification: { result: 'passed', by: 'exec-1' },
    independentReview: { reviewer: 'reviewer-2', result: 'approved' },
    integratedVerification: {
      result: 'passed',
      testsRun: 12,
      commitSha: 'a'.repeat(40),
    },
    failure: null,
    residualRisks: [],
    ...overrides,
  };
}

describe('parseOfficeReceipt', () => {
  it('reads a well-formed receipt', () => {
    expect(parseOfficeReceipt(receipt())).toMatchObject({
      outcome: 'succeeded',
    });
  });

  it('refuses an unknown major before reading any field', () => {
    const body = {
      ...receipt(),
      contract: 'tower.office.v2',
      outcome: 'nonsense',
    };
    let code: string | undefined;
    try {
      parseOfficeReceipt(body);
    } catch (error) {
      code = (error as ContractError).code;
    }
    expect(code).toBe('unsupported_major');
  });

  it('ignores unknown fields, as the versioning rules require', () => {
    const parsed = parseOfficeReceipt({
      ...receipt(),
      newFutureField: { anything: true },
    });
    expect(parsed).not.toHaveProperty('newFutureField');
    expect(parsed.receiptId).toBe('office.run-1');
  });

  it.each([
    ['a receipt id with a slash', { receiptId: 'a/b' }],
    ['an outcome outside the enum', { outcome: 'maybe' }],
    [
      'a commit that is not hex',
      {
        integratedVerification: {
          result: 'passed',
          testsRun: 1,
          commitSha: 'zz',
        },
      },
    ],
    [
      'negative tests run',
      {
        integratedVerification: {
          result: 'passed',
          testsRun: -1,
          commitSha: null,
        },
      },
    ],
    [
      'a reviewer that is not a string',
      { independentReview: { reviewer: 7, result: 'approved' } },
    ],
  ])('refuses %s', (_name, overrides) => {
    expect(() => parseOfficeReceipt({ ...receipt(), ...overrides })).toThrow(
      ContractError,
    );
  });

  it('turns an unknown failure class into no class, for the adapter to classify', () => {
    const parsed = parseOfficeReceipt(
      receipt({
        outcome: 'failed',
        failure: { class: 'made-up' as never, message: 'x' },
      }),
    );
    expect(parsed.failure).toEqual({ class: null, message: 'x' });
  });
});

describe('factsOf: self-verification versus independent review', () => {
  it('counts an approving reviewer who is not a producer as independent review', () => {
    expect(factsOf(receipt(), [PRODUCER]).independentReview).toBe('satisfied');
  });

  it('does not count a reviewer whose identity equals the Tower producer', () => {
    const facts = factsOf(
      receipt({
        independentReview: { reviewer: PRODUCER, result: 'approved' },
      }),
      [PRODUCER],
    );
    expect(facts.independentReview).toBe('self-reviewed');
  });

  it('does not count a reviewer whose identity equals the engine executor, ignoring case and space', () => {
    const facts = factsOf(
      receipt({
        independentReview: { reviewer: '  EXEC-1 ', result: 'approved' },
      }),
      [PRODUCER],
    );
    expect(facts.independentReview).toBe('self-reviewed');
  });

  it('treats the engine self-check as self-verification only, never as review', () => {
    const facts = factsOf(receipt({ independentReview: null }), [PRODUCER]);
    expect(facts.selfVerification).toBe('passed');
    expect(facts.independentReview).toBe('missing');
  });

  it('records a rejecting reviewer as rejected', () => {
    const facts = factsOf(
      receipt({
        independentReview: { reviewer: 'reviewer-2', result: 'rejected' },
      }),
      [PRODUCER],
    );
    expect(facts.independentReview).toBe('rejected');
  });
});

describe('isReady: what each risk level requires', () => {
  const green = factsOf(receipt({ independentReview: null }), [PRODUCER]);
  const reviewed = factsOf(receipt(), [PRODUCER]);

  it('a green test run with no review is not enough on a high-risk mission', () => {
    expect(isReady(green, 'high')).toBe(false);
  });

  it('needs independent review and integrated verification on high risk', () => {
    expect(isReady(reviewed, 'high')).toBe(true);
    const noIntegration = factsOf(receipt({ integratedVerification: null }), [
      PRODUCER,
    ]);
    expect(isReady(noIntegration, 'high')).toBe(false);
  });

  it('lower risk accepts a successful self-verified outcome', () => {
    expect(isReady(green, 'medium')).toBe(true);
    expect(isReady(green, 'low')).toBe(true);
  });

  it('a failed outcome is never ready, whatever it verified', () => {
    const failed = factsOf(
      receipt({
        outcome: 'failed',
        failure: { class: 'environment', message: '' },
      }),
      [PRODUCER],
    );
    expect(isReady(failed, 'low')).toBe(false);
  });
});

describe('isReady and failure classes, each condition on its own', () => {
  const selfFailed = factsOf(
    receipt({ selfVerification: { result: 'failed', by: 'exec-1' } }),
    [PRODUCER],
  );
  const selfAbsent = factsOf(receipt({ selfVerification: null }), [PRODUCER]);
  const integratedFailed = factsOf(
    receipt({
      integratedVerification: {
        result: 'failed',
        testsRun: 5,
        commitSha: null,
      },
    }),
    [PRODUCER],
  );
  const rejected = factsOf(
    receipt({
      independentReview: { reviewer: 'reviewer-2', result: 'rejected' },
    }),
    [PRODUCER],
  );

  it('a succeeded outcome with failed or absent self-verification is not ready on any risk', () => {
    expect(isReady(selfFailed, 'low')).toBe(false);
    expect(isReady(selfAbsent, 'low')).toBe(false);
  });

  it('a failed integrated verification or a rejected review is not ready on high risk', () => {
    expect(isReady(integratedFailed, 'high')).toBe(false);
    expect(isReady(rejected, 'high')).toBe(false);
  });

  it('keeps a policy-denial class the engine reports, rather than dropping it', () => {
    const parsed = parseOfficeReceipt(
      receipt({
        outcome: 'failed',
        failure: { class: 'policy-denial', message: 'rule denied' },
      }),
    );
    expect(parsed.failure?.class).toBe('policy-denial');
    expect(factsOf(parsed, [PRODUCER]).failureClass).toBe('policy-denial');
  });
});

describe('an integrated pass with nothing behind it is unproven', () => {
  const sha = 'a'.repeat(40);
  const withIntegration = (integratedVerification: unknown) =>
    factsOf(
      parseOfficeReceipt({
        ...receipt(),
        integratedVerification,
      }),
      [PRODUCER],
    );

  it('a pass that ran no tests is not proof on high risk', () => {
    const facts = withIntegration({
      result: 'passed',
      testsRun: 0,
      commitSha: sha,
    });
    expect(facts.integratedVerification).toBe('unproven');
    expect(isReady(facts, 'high')).toBe(false);
  });

  it('a pass with no commit is not proof on high risk', () => {
    const facts = withIntegration({
      result: 'passed',
      testsRun: 4,
      commitSha: null,
    });
    expect(facts.integratedVerification).toBe('unproven');
    expect(isReady(facts, 'high')).toBe(false);
  });

  it('a pass with tests and a commit is proof', () => {
    const facts = withIntegration({
      result: 'passed',
      testsRun: 4,
      commitSha: sha,
    });
    expect(facts.integratedVerification).toBe('passed');
    expect(isReady(facts, 'high')).toBe(true);
  });
});
