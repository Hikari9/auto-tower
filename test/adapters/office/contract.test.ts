import { describe, expect, it } from 'vitest';
import {
  assertOfficeContract,
  ContractError,
  OFFICE_CONTRACT_ID,
  parseContractId,
} from '../../../src/adapters/office/contract.js';
import { buildOfficePacket } from '../../../src/adapters/office/packet.js';

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof ContractError ? error.code : 'not a ContractError';
  }
  return 'no error';
}

describe('contract ids', () => {
  it('parses boundary and major', () => {
    expect(parseContractId('tower.office.v1')).toEqual({
      boundary: 'office',
      major: 1,
    });
    expect(parseContractId('tower.runner.v12')).toEqual({
      boundary: 'runner',
      major: 12,
    });
  });

  it.each([
    ['not a string', 1],
    ['no version', 'tower.office'],
    ['leading zero', 'tower.office.v01'],
    ['wrong prefix', 'acme.office.v1'],
    ['upper case boundary', 'tower.Office.v1'],
  ])('refuses a malformed id (%s)', (_name, value) => {
    expect(() => parseContractId(value)).toThrow(ContractError);
    try {
      parseContractId(value);
    } catch (error) {
      expect((error as ContractError).code).toBe('malformed');
    }
  });

  it('accepts the supported major of its own boundary', () => {
    expect(assertOfficeContract(OFFICE_CONTRACT_ID)).toEqual({
      boundary: 'office',
      major: 1,
    });
  });

  it('rejects an unknown major with a typed error, not a guess at compatibility', () => {
    const error = (() => {
      try {
        assertOfficeContract('tower.office.v2');
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(ContractError);
    expect((error as ContractError).code).toBe('unsupported_major');
    expect((error as Error).message).toMatch(/major 2; this adapter serves v1/);
  });

  it('rejects another boundary, even at a supported major', () => {
    expect(codeOf(() => assertOfficeContract('tower.runner.v1'))).toBe(
      'wrong_boundary',
    );
  });
});

describe('outbound packet wire shape', () => {
  it('pins every field name and the fixed values, so a rename fails here', () => {
    const packet = buildOfficePacket({
      missionId: 'mis_1',
      packetId: 'pkt_1',
      attemptId: 'att_1',
      leaseId: 'lse_1',
      fence: 3,
      scopeKey: 'repo:a#worktree:default',
      packet: { title: 'Title', instructions: 'Do it', scope: ['repo:a'] },
      mission: { intent: 'Intent', outcome: 'Outcome', constraints: ['c1'] },
      resume: { progressSeq: 2, checkpoint: { ref: 'work/x', commit: null } },
    });
    expect(Object.keys(packet).sort()).toEqual(
      [
        'attemptId',
        'constraints',
        'contract',
        'correlationId',
        'evidenceProfile',
        'fence',
        'instructions',
        'intent',
        'kind',
        'leaseId',
        'missionId',
        'outcome',
        'packetId',
        'policyRefs',
        'resume',
        'scope',
        'scopeKey',
        'title',
      ].sort(),
    );
    expect(packet).toMatchObject({
      contract: 'tower.office.v1',
      kind: 'work-packet',
      correlationId: 'att_1',
      policyRefs: [],
      evidenceProfile: 'standard',
    });
  });
});

describe('outbound packet values', () => {
  it('maps each lease and mission field to the packet field it names', () => {
    const packet = buildOfficePacket({
      missionId: 'mis_1',
      packetId: 'pkt_1',
      attemptId: 'att_1',
      leaseId: 'lse_1',
      fence: 3,
      scopeKey: 'repo:a#worktree:default',
      packet: { title: 'Title', instructions: 'Do it', scope: ['repo:a'] },
      mission: { intent: 'Intent', outcome: 'Outcome', constraints: ['c1'] },
      resume: { progressSeq: 2, checkpoint: { ref: 'work/x', commit: null } },
    });
    expect(packet).toMatchObject({
      missionId: 'mis_1',
      packetId: 'pkt_1',
      attemptId: 'att_1',
      leaseId: 'lse_1',
      fence: 3,
      scopeKey: 'repo:a#worktree:default',
      title: 'Title',
      instructions: 'Do it',
      scope: ['repo:a'],
      intent: 'Intent',
      outcome: 'Outcome',
      constraints: ['c1'],
      resume: { progressSeq: 2, checkpoint: { ref: 'work/x', commit: null } },
    });
  });
});
