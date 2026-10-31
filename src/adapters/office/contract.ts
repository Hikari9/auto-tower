/**
 * Contract ids name a boundary and its major version: `tower.<boundary>.v<major>`. See
 * docs/adapters.md. A major version this code does not serve is refused with a typed error. It is
 * never guessed at.
 */

export const OFFICE_BOUNDARY = 'office';
export const OFFICE_CONTRACT_ID = 'tower.office.v1';

/** Majors this adapter reads and writes. Adding one here is a contract change and needs a doc update. */
export const OFFICE_SUPPORTED_MAJORS: readonly number[] = [1];

export type ContractErrorCode =
  | 'malformed'
  | 'wrong_boundary'
  | 'unsupported_major'
  | 'invalid';

export class ContractError extends Error {
  override readonly name = 'ContractError';

  constructor(
    readonly code: ContractErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface ContractId {
  boundary: string;
  major: number;
}

const CONTRACT = /^tower\.([a-z][a-z-]*)\.v(0|[1-9]\d{0,3})$/;

export function parseContractId(value: unknown): ContractId {
  if (typeof value !== 'string') {
    throw new ContractError('malformed', 'contract id must be a string');
  }
  const match = CONTRACT.exec(value);
  if (match === null) {
    throw new ContractError(
      'malformed',
      `contract id ${JSON.stringify(value)} is not tower.<boundary>.v<major>`,
    );
  }
  return { boundary: match[1] ?? '', major: Number(match[2]) };
}

/** Accepts a contract id for this boundary at a supported major, or throws a typed error. */
export function assertOfficeContract(
  value: unknown,
  supportedMajors: readonly number[] = OFFICE_SUPPORTED_MAJORS,
): ContractId {
  const id = parseContractId(value);
  if (id.boundary !== OFFICE_BOUNDARY) {
    throw new ContractError(
      'wrong_boundary',
      `contract ${JSON.stringify(value)} is for the ${id.boundary} boundary, not ${OFFICE_BOUNDARY}`,
    );
  }
  if (!supportedMajors.includes(id.major)) {
    throw new ContractError(
      'unsupported_major',
      `contract ${JSON.stringify(value)} is major ${id.major}; this adapter serves ${supportedMajors.map((m) => `v${m}`).join(', ')}`,
    );
  }
  return id;
}
