export type ErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'invalid'
  | 'invalid_transition'
  | 'policy_denied'
  | 'fenced'
  | 'halted'
  | 'unavailable'
  | 'rate_limited'
  | 'idempotency_mismatch';

const STATUS: Record<ErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  invalid: 400,
  invalid_transition: 409,
  policy_denied: 403,
  fenced: 409,
  halted: 423,
  unavailable: 503,
  rate_limited: 429,
  idempotency_mismatch: 422,
};

export class TowerError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'TowerError';
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return STATUS[this.code];
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) } };
  }
}

export const fail = (code: ErrorCode, message: string, details?: Record<string, unknown>): never => {
  throw new TowerError(code, message, details);
};
