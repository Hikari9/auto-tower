import { PRINCIPAL_KINDS, type PrincipalKind } from '../auth/principals.js';
import { ValidationError } from '../core/errors.js';
import { RISKS, type Risk } from '../core/types.js';
import { InputReader, LIMITS } from '../core/validation.js';
import { ACTION_PATTERN } from './actions.js';
import { MAX_PATTERN_LENGTH, MAX_WILDCARDS } from './patterns.js';
import {
  type Grantee,
  RULE_EFFECTS,
  type RuleEffect,
  type RuleLimits,
} from './types.js';

const ID = { max: 128, min: 1 } as const;
const MAX_MISSION_IDS = 50;
const MAX_AMOUNT = 1e12;
const MAX_PREFERENCE_BYTES = 4_096;
const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
/** `Date.parse` rolls 30 February forward into March. A date that does not exist is refused instead. */
function realDate(value: string): boolean {
  const [y, mo, d, h, mi, sec] = value.slice(0, 19).split(/[-T:]/).map(Number);
  const inMonth = new Date(Date.UTC(y ?? 0, mo ?? 0, 0)).getUTCDate();
  return (
    (mo ?? 0) >= 1 &&
    (mo ?? 13) <= 12 &&
    (d ?? 0) >= 1 &&
    (d ?? 99) <= inMonth &&
    (h ?? 99) <= 23 &&
    (mi ?? 99) <= 59 &&
    (Number.isNaN(sec ?? Number.NaN) ? 0 : (sec ?? 0)) <= 59
  );
}

const CONTROL_CHARS = /\p{Cc}/u;

export interface CreateRuleInput {
  effect: RuleEffect;
  action: string;
  resource: string;
  scope: string;
  maxRisk: Risk;
  grantee: Grantee;
  limits: RuleLimits;
  expiresAt: string | null;
  note: string | null;
}

export interface RuleChanges {
  action?: string;
  resource?: string;
  scope?: string;
  maxRisk?: Risk;
  grantee?: Grantee;
  limits?: RuleLimits;
  expiresAt?: string | null;
  note?: string | null;
}

export interface EvaluationQuery {
  action: string;
  resource: string;
  scope: string;
  risk: Risk;
  amount: number | undefined;
  missionId: string | undefined;
  principalId: string | undefined;
}

/** What a human narrows a proposal to. Each field left out keeps the proposal's value. */
export interface NarrowInput {
  resource?: string;
  scope?: string;
  maxRisk?: Risk;
  maxAmount?: number;
  missionIds?: string[];
  granteePrincipalId?: string;
  expiresAt?: string;
  note: string | null;
}

function expectedVersion(reader: InputReader): number {
  return reader.integer('expectedVersion', { min: 1, max: 2_147_483_647 });
}

function checkPattern(
  reader: InputReader,
  key: string,
  value: string | undefined,
  kind: 'action' | 'text',
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const wildcards = value.split('*').length - 1;
  if (wildcards > MAX_WILDCARDS) {
    reader.fail(key, `may contain at most ${MAX_WILDCARDS} wildcards`);
  } else if (kind === 'action' && !/^[a-z*][a-z0-9_.*-]*$/.test(value)) {
    reader.fail(key, 'must be lower-case dotted segments, with * as wildcard');
  } else if (kind === 'text' && CONTROL_CHARS.test(value)) {
    reader.fail(key, 'must not contain control characters');
  }
  return value;
}

/** An instant as canonical ISO text, so stored values compare as strings. */
function checkInstant(
  reader: InputReader,
  key: string,
  value: string | null | undefined,
): string | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  // An offset is required: without one `Date.parse` reads the host's local time zone.
  const ms =
    RFC3339.test(value) && realDate(value) ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(ms)) {
    reader.fail(
      key,
      'must be an ISO 8601 date and time with a time zone, such as 2026-12-31T00:00:00Z',
    );
    return undefined;
  }
  return new Date(ms).toISOString();
}

/**
 * Reads the object under `key` with its own reader, so its fields report as `key.field`.
 * Returns the body without that key, ready for the main reader.
 */
export function readNested<T>(
  reader: InputReader,
  body: unknown,
  key: string,
  read: (nested: InputReader) => T,
): { rest: unknown; value: T | undefined } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { rest: body, value: undefined };
  }
  const { [key]: raw, ...rest } = body as Record<string, unknown>;
  if (raw === undefined) {
    return { rest, value: undefined };
  }
  const nested = new InputReader(raw, key);
  const value = read(nested);
  for (const issue of nested.finishIssues()) {
    reader.fail(issue.path, issue.message);
  }
  return { rest, value };
}

function readGrantee(item: InputReader): Grantee {
  const kind = item.optEnum('kind', PRINCIPAL_KINDS) as
    | PrincipalKind
    | undefined;
  const principalId = item.optString('principalId', ID);
  if (kind === undefined && principalId === undefined) {
    item.fail('kind', 'or principalId is required');
  }
  return { kind: kind ?? null, principalId: principalId ?? null };
}

function readLimits(item: InputReader): RuleLimits {
  const maxAmount = readAmount(item, 'maxAmount');
  const missionIds = item.optStrings('missionIds', {
    maxItems: MAX_MISSION_IDS,
    maxLength: ID.max,
    minLength: 1,
  });
  if (missionIds !== undefined && missionIds.length === 0) {
    item.fail('missionIds', 'needs at least one mission, or omit it');
  }
  return { maxAmount: maxAmount ?? null, missionIds: missionIds ?? null };
}

/** Amounts are whole units of the smallest denomination, so no rounding decides a limit. */
function readAmount(reader: InputReader, key: string): number | undefined {
  return reader.optInteger(key, { min: 0, max: MAX_AMOUNT });
}

const NOTE = { max: LIMITS.reason } as const;
const PATTERN = { max: MAX_PATTERN_LENGTH, min: 1 } as const;

export function parseCreateRule(body: unknown): CreateRuleInput {
  const r = new InputReader({});
  const g = readNested(r, body, 'grantee', readGrantee);
  const l = readNested(r, g.rest, 'limits', readLimits);
  const main = new InputReader(l.rest);
  for (const issue of r.finishIssues()) {
    main.fail(issue.path, issue.message);
  }
  const effect = main.optEnum('effect', RULE_EFFECTS) ?? 'allow';
  const action = checkPattern(
    main,
    'action',
    main.string('action', { max: 128, min: 1 }),
    'action',
  );
  const resource = checkPattern(
    main,
    'resource',
    main.string('resource', PATTERN),
    'text',
  );
  const scope = checkPattern(
    main,
    'scope',
    main.string('scope', PATTERN),
    'text',
  );
  const maxRisk = main.optEnum('maxRisk', RISKS);
  const expiresAt = checkInstant(
    main,
    'expiresAt',
    main.optNullableString('expiresAt', { max: 64 }),
  );
  const note = main.optNullableString('note', NOTE);
  const grantee = g.value ?? { kind: null, principalId: null };
  const limits = l.value ?? { maxAmount: null, missionIds: null };

  if (effect === 'allow' && g.value === undefined) {
    main.fail('grantee', 'is required for a grant');
  }
  if (
    effect === 'deny' &&
    (maxRisk !== undefined || limits.maxAmount !== null)
  ) {
    main.fail('effect', 'a deny rule applies at every risk and amount');
  }
  main.finish();
  return {
    effect,
    action: action ?? '',
    resource: resource ?? '',
    scope: scope ?? '',
    maxRisk: maxRisk ?? 'low',
    grantee,
    limits,
    expiresAt: expiresAt ?? null,
    note: note ?? null,
  };
}

export function parseAmendRule(body: unknown): {
  expectedVersion: number;
  changes: RuleChanges;
} {
  const r = new InputReader({});
  const g = readNested(r, body, 'grantee', readGrantee);
  const l = readNested(r, g.rest, 'limits', readLimits);
  const main = new InputReader(l.rest);
  for (const issue of r.finishIssues()) {
    main.fail(issue.path, issue.message);
  }
  const version = expectedVersion(main);
  const changes: RuleChanges = {};
  const action = checkPattern(
    main,
    'action',
    main.optString('action', { max: 128, min: 1 }),
    'action',
  );
  const resource = checkPattern(
    main,
    'resource',
    main.optString('resource', PATTERN),
    'text',
  );
  const scope = checkPattern(
    main,
    'scope',
    main.optString('scope', PATTERN),
    'text',
  );
  const maxRisk = main.optEnum('maxRisk', RISKS);
  const hadExpiry = main.has('expiresAt');
  const expiresAt = checkInstant(
    main,
    'expiresAt',
    main.optNullableString('expiresAt', { max: 64 }),
  );
  const hadNote = main.has('note');
  const note = main.optNullableString('note', NOTE);
  if (action !== undefined) changes.action = action;
  if (resource !== undefined) changes.resource = resource;
  if (scope !== undefined) changes.scope = scope;
  if (maxRisk !== undefined) changes.maxRisk = maxRisk;
  if (g.value !== undefined) changes.grantee = g.value;
  if (l.value !== undefined) changes.limits = l.value;
  if (hadExpiry && expiresAt !== undefined) changes.expiresAt = expiresAt;
  if (hadNote && note !== undefined) changes.note = note;
  if (Object.keys(changes).length === 0 && !main.finishIssues().length) {
    main.fail('(body)', 'names no change');
  }
  main.finish();
  return { expectedVersion: version, changes };
}

export function parseRevoke(body: unknown): {
  expectedVersion: number;
  reason: string | null;
} {
  const r = new InputReader(body);
  const version = expectedVersion(r);
  const reason = r.optNullableString('reason', NOTE) ?? null;
  r.finish();
  return { expectedVersion: version, reason };
}

export function parseEvaluation(body: unknown): EvaluationQuery {
  const r = new InputReader(body);
  const input: EvaluationQuery = {
    action: r.string('action', { max: 128, min: 1 }),
    resource: r.string('resource', PATTERN),
    scope: r.string('scope', PATTERN),
    risk: r.enum('risk', RISKS),
    amount: readAmount(r, 'amount'),
    missionId: r.optString('missionId', ID),
    principalId: r.optString('principalId', ID),
  };
  if (!ACTION_PATTERN.test(input.action)) {
    r.fail('action', 'must be lower-case dotted segments');
  }
  r.finish();
  return input;
}

export function parseNarrow(body: unknown): NarrowInput {
  const r = new InputReader(body);
  const input: NarrowInput = { note: null };
  const resource = r.optString('resource', PATTERN);
  const scope = r.optString('scope', PATTERN);
  const maxRisk = r.optEnum('maxRisk', RISKS);
  const maxAmount = readAmount(r, 'maxAmount');
  const missionIds = r.optStrings('missionIds', {
    maxItems: MAX_MISSION_IDS,
    maxLength: ID.max,
    minLength: 1,
  });
  const granteePrincipalId = r.optString('granteePrincipalId', ID);
  const expiresAt = checkInstant(
    r,
    'expiresAt',
    r.optString('expiresAt', { max: 64 }),
  );
  input.note = r.optNullableString('note', NOTE) ?? null;
  if (resource !== undefined)
    input.resource = checkPattern(r, 'resource', resource, 'text') ?? resource;
  if (scope !== undefined)
    input.scope = checkPattern(r, 'scope', scope, 'text') ?? scope;
  if (maxRisk !== undefined) input.maxRisk = maxRisk;
  if (maxAmount !== undefined) input.maxAmount = maxAmount;
  if (missionIds !== undefined) input.missionIds = missionIds;
  if (granteePrincipalId !== undefined)
    input.granteePrincipalId = granteePrincipalId;
  if (typeof expiresAt === 'string') input.expiresAt = expiresAt;
  const narrowed = Object.keys(input).filter((key) => key !== 'note');
  if (narrowed.length === 0) {
    r.fail('(body)', 'names nothing to narrow; accept the proposal instead');
  }
  r.finish();
  return input;
}

export function parseNote(body: unknown): { note: string | null } {
  const r = new InputReader(body);
  const note = r.optNullableString('note', NOTE) ?? null;
  r.finish();
  return { note };
}

export function parsePreference(body: unknown): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ValidationError([{ path: '', message: 'must be a JSON object' }]);
  }
  const keys = Object.keys(body);
  const value = (body as Record<string, unknown>).value;
  if (keys.length !== 1 || keys[0] !== 'value' || value === undefined) {
    throw new ValidationError([
      { path: 'value', message: 'is the only field, and is required' },
    ]);
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_PREFERENCE_BYTES) {
    throw new ValidationError([
      {
        path: 'value',
        message: `must be at most ${MAX_PREFERENCE_BYTES} bytes`,
      },
    ]);
  }
  return value;
}

export const PREFERENCE_KEY = /^[A-Za-z0-9][\w.:/-]{0,127}$/;
