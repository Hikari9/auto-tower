import { ValidationError } from '../core/errors.js';
import { InputReader } from '../core/validation.js';
import { redactString } from './redact.js';
import { LEASE_STATUSES, type LeaseStatus } from './store.js';
import { isDigest, isVersion } from './version.js';

const ID = { max: 128, min: 1 } as const;
const FENCE = { min: 1, max: 2_147_483_647 } as const;
const CAPABILITY = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const RECEIPT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_JSON_BYTES = 16 * 1024;

export const MAX_SUMMARY = 4_000;
export const MAX_EVIDENCE_ITEMS = 50;

export interface Binding {
  version: string;
  buildDigest: string;
}

export interface Evidence {
  leaseId: string;
  attemptId: string;
  fence: number;
  progressSeq: number;
}

function version(r: InputReader): string {
  const value = r.string('version', { max: 32, min: 1 });
  if (value !== '' && !isVersion(value)) {
    r.fail('version', 'must be major.minor.patch');
  }
  return value;
}

function digest(r: InputReader, key: string): string {
  const value = r.string(key, { max: 71, min: 1 });
  if (value !== '' && !isDigest(value)) {
    r.fail(key, 'must be sha256: followed by 64 lowercase hex characters');
  }
  return value;
}

function capabilities(r: InputReader, key: string): string[] | undefined {
  const values = r.optStrings(key, {
    maxItems: 64,
    maxLength: 64,
    minLength: 1,
  });
  for (const value of values ?? []) {
    if (!CAPABILITY.test(value)) {
      r.fail(key, `${JSON.stringify(value)} is not a valid capability name`);
    }
  }
  return values === undefined ? undefined : [...new Set(values)];
}

function scopes(r: InputReader, key: string): string[] | undefined {
  const values = r.optStrings(key, {
    maxItems: 50,
    maxLength: 200,
    minLength: 1,
  });
  return values === undefined ? undefined : [...new Set(values)];
}

/** Takes one free-form JSON field out of the body, since the field reader only knows scalars. */
function takeJson(
  body: unknown,
  key: string,
): { rest: unknown; value: unknown; error: string | undefined } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { rest: body, value: undefined, error: undefined };
  }
  const { [key]: value, ...rest } = body as Record<string, unknown>;
  if (value === undefined) {
    return { rest, value: undefined, error: undefined };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { rest, value: undefined, error: 'must be a JSON object' };
  }
  if (JSON.stringify(value).length > MAX_JSON_BYTES) {
    return {
      rest,
      value: undefined,
      error: `must be under ${MAX_JSON_BYTES} bytes`,
    };
  }
  return { rest, value, error: undefined };
}

function binding(r: InputReader): Binding {
  return { version: version(r), buildDigest: digest(r, 'buildDigest') };
}

function evidence(item: InputReader): Evidence {
  return {
    leaseId: item.string('leaseId', ID),
    attemptId: item.string('attemptId', ID),
    fence: item.integer('fence', FENCE),
    progressSeq: item.integer('progressSeq', { min: 0, max: 2_147_483_647 }),
  };
}

export interface IssueEnrollmentInput {
  name: string;
  version: string;
  buildDigest: string;
  allowedScopes: string[];
  maxConcurrent: number;
  expiresInSeconds: number | undefined;
}

export function parseIssueEnrollment(body: unknown): IssueEnrollmentInput {
  const r = new InputReader(body);
  const input = {
    name: r.string('name', { max: 100, min: 1 }),
    version: version(r),
    buildDigest: digest(r, 'buildDigest'),
    allowedScopes: scopes(r, 'allowedScopes') ?? [],
    maxConcurrent: r.optInteger('maxConcurrent', { min: 1, max: 32 }) ?? 1,
    expiresInSeconds: r.optInteger('expiresInSeconds', {
      min: 60,
      max: 86_400,
    }),
  };
  r.finish();
  return input;
}

export interface RegisterInput extends Binding {
  capabilities: string[];
}

export function parseRegister(body: unknown): RegisterInput {
  const r = new InputReader(body);
  const input = {
    ...binding(r),
    capabilities: capabilities(r, 'capabilities') ?? [],
  };
  r.finish();
  return input;
}

export interface PollInput extends Binding {
  capabilities: string[] | undefined;
  active: Evidence[];
}

export function parsePoll(body: unknown): PollInput {
  const r = new InputReader(body);
  const input = {
    ...binding(r),
    capabilities: capabilities(r, 'capabilities'),
    active: r.optItems('active', MAX_EVIDENCE_ITEMS, evidence) ?? [],
  };
  r.finish();
  return input;
}

export interface ReconcileInput extends Binding {
  fence: number;
  progressSeq: number;
}

export function parseReconcile(body: unknown): ReconcileInput {
  const r = new InputReader(body);
  const input = {
    ...binding(r),
    fence: r.integer('fence', FENCE),
    progressSeq: r.integer('progressSeq', { min: 0, max: 2_147_483_647 }),
  };
  r.finish();
  return input;
}

export interface ProgressInput {
  fence: number;
  seq: number;
  message: string;
  data: Record<string, unknown>;
}

export function parseProgress(body: unknown): ProgressInput {
  const json = takeJson(body, 'data');
  const r = new InputReader(json.rest);
  const input = {
    fence: r.integer('fence', FENCE),
    seq: r.integer('seq', { min: 1, max: 2_147_483_647 }),
    message: r.optString('message', { max: MAX_SUMMARY }) ?? '',
    data: (json.value ?? {}) as Record<string, unknown>,
  };
  if (json.error !== undefined) {
    r.fail('data', json.error);
  }
  r.finish();
  return input;
}

export interface CheckpointInput {
  fence: number;
  ref: string;
  commit: string | null;
}

export function parseCheckpoint(body: unknown): CheckpointInput {
  const r = new InputReader(body);
  const ref = r.string('ref', { max: 200, min: 1 });
  // A portable ref is a branch or tag name another runner can fetch. The strict charset
  // keeps credentials and URLs out of it.
  if (
    ref !== '' &&
    (!REF.test(ref) ||
      ref.includes('..') ||
      ref.includes('//') ||
      ref.endsWith('/') ||
      ref.endsWith('.lock') ||
      redactString(ref) !== ref)
  ) {
    r.fail(
      'ref',
      'must be a branch or tag name starting with a letter or digit, using only letters, digits, . _ / -',
    );
  }
  const commit = r.optString('commit', { max: 64, min: 1 }) ?? null;
  if (commit !== null && !COMMIT.test(commit)) {
    r.fail('commit', 'must be a full lowercase hex commit id');
  }
  const input = { fence: r.integer('fence', FENCE), ref, commit };
  r.finish();
  return input;
}

export interface ReceiptInput {
  receiptId: string;
  fence: number;
  outcome: 'succeeded' | 'failed';
  summary: string;
  evidence: Record<string, unknown>;
}

export function parseReceipt(body: unknown): ReceiptInput {
  const json = takeJson(body, 'evidence');
  const r = new InputReader(json.rest);
  const receiptId = r.string('receiptId', ID);
  if (receiptId !== '' && !RECEIPT_ID.test(receiptId)) {
    r.fail('receiptId', 'may only contain letters, digits, . _ : -');
  } else if (redactString(receiptId) !== receiptId) {
    r.fail('receiptId', 'must not look like a credential');
  }
  const input = {
    receiptId,
    fence: r.integer('fence', FENCE),
    outcome: r.enum('outcome', ['succeeded', 'failed'] as const),
    summary: r.optString('summary', { max: MAX_SUMMARY }) ?? '',
    evidence: (json.value ?? {}) as Record<string, unknown>,
  };
  if (json.error !== undefined) {
    r.fail('evidence', json.error);
  }
  r.finish();
  return input;
}

export interface UpdateRunnerInput {
  allowedScopes: string[] | undefined;
  maxConcurrent: number | undefined;
  paused: boolean | undefined;
}

export function parseUpdateRunner(body: unknown): UpdateRunnerInput {
  const r = new InputReader(body);
  const input = {
    allowedScopes: scopes(r, 'allowedScopes'),
    maxConcurrent: r.optInteger('maxConcurrent', { min: 0, max: 32 }),
    paused: r.optBoolean('paused'),
  };
  if (Object.values(input).every((value) => value === undefined)) {
    r.fail('', 'must change at least one field');
  }
  r.finish();
  return input;
}

export function parseReason(body: unknown): string | null {
  const r = new InputReader(body);
  const reason = r.optString('reason', { max: 1_000 }) ?? null;
  r.finish();
  return reason;
}

export function parseLeaseQuery(query: Record<string, string>): {
  status: LeaseStatus | undefined;
  limit: number;
} {
  const issues = [];
  const status = query.status;
  if (
    status !== undefined &&
    !(LEASE_STATUSES as readonly string[]).includes(status)
  ) {
    issues.push({
      path: 'status',
      message: `must be one of ${LEASE_STATUSES.join(', ')}`,
    });
  }
  const limit = query.limit === undefined ? 100 : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    issues.push({ path: 'limit', message: 'must be an integer from 1 to 500' });
  }
  if (issues.length > 0) {
    throw new ValidationError(issues);
  }
  return { status: status as LeaseStatus | undefined, limit };
}

export function parseAuditQuery(query: Record<string, string>): {
  afterSeq: number;
  limit: number;
} {
  const afterSeq = query.after === undefined ? 0 : Number(query.after);
  const limit = query.limit === undefined ? 100 : Number(query.limit);
  const issues = [];
  if (!Number.isInteger(afterSeq) || afterSeq < 0) {
    issues.push({ path: 'after', message: 'must be a non-negative integer' });
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
    issues.push({ path: 'limit', message: 'must be an integer from 1 to 500' });
  }
  if (issues.length > 0) {
    throw new ValidationError(issues);
  }
  return { afterSeq, limit };
}
