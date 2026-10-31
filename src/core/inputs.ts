import { ValidationError } from './errors.js';
import type { SearchQuery } from './projection.js';
import type { MissionChanges } from './reducer.js';
import {
  type DoneItem,
  type IssueLinkRef,
  MISSION_STATUSES,
  type MissionStatus,
  PRIORITIES,
  type Priority,
  RISKS,
  type Risk,
  SIZES,
  type Size,
} from './types.js';
import {
  InputReader,
  LIMITS,
  readConstraints,
  readDefinitionOfDone,
  readLinks,
  readRefs,
} from './validation.js';

export interface CreateMissionInput {
  title: string;
  intent: string;
  outcome: string;
  constraints: string[];
  risk: Risk;
  size: Size;
  priority: Priority;
  definitionOfDone: DoneItem[];
  source: string;
  parentId: string | null;
  requiredForParent: boolean;
  links: IssueLinkRef[];
  policyRefs: string[];
}

export interface AddPacketInput {
  title: string;
  instructions: string;
  scope: string[];
  required: boolean;
  dependsOn: string[];
}

const ID = { max: 128, min: 1 } as const;

function expectedVersion(reader: InputReader): number {
  return reader.integer('expectedVersion', { min: 1, max: 2_147_483_647 });
}

function requireRefs(reader: InputReader, key: string): string[] {
  const refs = readRefs(reader, key);
  if (refs.length === 0 && !reader.has(key)) {
    reader.fail(key, 'is required and needs at least one reference');
  } else if (refs.length === 0) {
    reader.fail(key, 'needs at least one reference');
  }
  return refs;
}

export function parseCreateMission(body: unknown): CreateMissionInput {
  const r = new InputReader(body);
  const input: CreateMissionInput = {
    title: r.string('title', { max: LIMITS.title, min: 1 }),
    intent: r.string('intent', { max: LIMITS.text, min: 1 }),
    outcome: r.string('outcome', { max: LIMITS.text, min: 1 }),
    constraints: readConstraints(r, 'constraints') ?? [],
    risk: r.optEnum('risk', RISKS) ?? 'medium',
    size: r.optEnum('size', SIZES) ?? 'm',
    priority: r.optEnum('priority', PRIORITIES) ?? 'normal',
    definitionOfDone: readDefinitionOfDone(r, 'definitionOfDone') ?? [],
    source: r.optString('source', { max: LIMITS.source, min: 1 }) ?? 'api',
    parentId: r.optNullableString('parentId', ID) ?? null,
    requiredForParent: r.optBoolean('requiredForParent') ?? true,
    links: readLinks(r, 'links') ?? [],
    policyRefs: readRefs(r, 'policyRefs'),
  };
  // A new mission has nothing done yet. Only a verifier marks items done, by updating later.
  input.definitionOfDone.forEach((item, index) => {
    if (item.done) {
      r.fail(`definitionOfDone[${index}].done`, 'must be false on creation');
    }
  });
  r.finish();
  return input;
}

export function parseUpdateMission(body: unknown): {
  expectedVersion: number;
  changes: MissionChanges;
} {
  const r = new InputReader(body);
  const version = expectedVersion(r);
  const changes: MissionChanges = {};
  const title = r.optString('title', { max: LIMITS.title, min: 1 });
  const intent = r.optString('intent', { max: LIMITS.text, min: 1 });
  const outcome = r.optString('outcome', { max: LIMITS.text, min: 1 });
  const constraints = readConstraints(r, 'constraints');
  const risk = r.optEnum('risk', RISKS);
  const size = r.optEnum('size', SIZES);
  const priority = r.optEnum('priority', PRIORITIES);
  const definitionOfDone = readDefinitionOfDone(r, 'definitionOfDone');
  const links = readLinks(r, 'links');
  const policyRefs = r.has('policyRefs')
    ? readRefs(r, 'policyRefs')
    : undefined;
  if (title !== undefined) changes.title = title;
  if (intent !== undefined) changes.intent = intent;
  if (outcome !== undefined) changes.outcome = outcome;
  if (constraints !== undefined) changes.constraints = constraints;
  if (risk !== undefined) changes.risk = risk;
  if (size !== undefined) changes.size = size;
  if (priority !== undefined) changes.priority = priority;
  if (definitionOfDone !== undefined)
    changes.definitionOfDone = definitionOfDone;
  if (links !== undefined) changes.links = links;
  if (policyRefs !== undefined) changes.policyRefs = policyRefs;
  r.finish();
  if (Object.keys(changes).length === 0) {
    throw new ValidationError([
      { path: '', message: 'must change at least one field' },
    ]);
  }
  return { expectedVersion: version, changes };
}

export function parseTransition(body: unknown): {
  expectedVersion: number;
  to: MissionStatus;
  reason: string | null;
} {
  const r = new InputReader(body);
  const parsed = {
    expectedVersion: expectedVersion(r),
    to: r.enum('to', MISSION_STATUSES),
    reason: r.optString('reason', { max: LIMITS.reason }) ?? null,
  };
  r.finish();
  return parsed;
}

export function parseCancel(body: unknown): {
  expectedVersion: number;
  reason: string | null;
} {
  const r = new InputReader(body);
  const parsed = {
    expectedVersion: expectedVersion(r),
    reason: r.optString('reason', { max: LIMITS.reason }) ?? null,
  };
  r.finish();
  return parsed;
}

export function parseEvidenceCommand(body: unknown): {
  expectedVersion: number;
  evidenceRefs: string[];
} {
  const r = new InputReader(body);
  const parsed = {
    expectedVersion: expectedVersion(r),
    evidenceRefs: requireRefs(r, 'evidenceRefs'),
  };
  r.finish();
  return parsed;
}

export function parseAddPacket(body: unknown): {
  expectedVersion: number;
  packet: AddPacketInput;
} {
  const r = new InputReader(body);
  const version = expectedVersion(r);
  const packet: AddPacketInput = {
    title: r.string('title', { max: LIMITS.title, min: 1 }),
    instructions: r.optString('instructions', { max: LIMITS.text }) ?? '',
    scope:
      r.optStrings('scope', {
        maxItems: LIMITS.scopeItems,
        maxLength: 300,
        minLength: 1,
      }) ?? [],
    required: r.optBoolean('required') ?? true,
    dependsOn:
      r.optStrings('dependsOn', {
        maxItems: LIMITS.dependsOn,
        maxLength: ID.max,
        minLength: 1,
      }) ?? [],
  };
  if (new Set(packet.dependsOn).size !== packet.dependsOn.length) {
    r.fail('dependsOn', 'lists a packet more than once');
  }
  r.finish();
  return { expectedVersion: version, packet };
}

export function parseAddDependency(body: unknown): {
  expectedVersion: number;
  dependsOnPacketId: string;
} {
  const r = new InputReader(body);
  const parsed = {
    expectedVersion: expectedVersion(r),
    dependsOnPacketId: r.string('dependsOn', ID),
  };
  r.finish();
  return parsed;
}

export function parseAuthorize(body: unknown): {
  expectedVersion: number;
  policyRefs: string[];
} {
  const r = new InputReader(body);
  const parsed = {
    expectedVersion: expectedVersion(r),
    policyRefs: readRefs(r, 'policyRefs'),
  };
  r.finish();
  return parsed;
}

export function parseReject(body: unknown): {
  expectedVersion: number;
  reason: string | null;
} {
  return parseCancel(body);
}

export function parseVersionOnly(body: unknown): { expectedVersion: number } {
  const r = new InputReader(body);
  const parsed = { expectedVersion: expectedVersion(r) };
  r.finish();
  return parsed;
}

const SEARCH_LIMIT = { default: 25, max: 100 } as const;

/** Reads search filters from URL query parameters (all strings). */
export function parseSearch(
  params: Readonly<Record<string, string>>,
): SearchQuery {
  const r = new InputReader(params);
  const states = r
    .optString('state', { max: 400 })
    ?.split(',')
    .filter((s) => s !== '');
  for (const state of states ?? []) {
    if (!(MISSION_STATUSES as readonly string[]).includes(state)) {
      r.fail('state', `${state} is not a mission state`);
    }
  }
  const query: SearchQuery = {
    limit: numeric(r, 'limit', 1, SEARCH_LIMIT.max) ?? SEARCH_LIMIT.default,
    offset: numeric(r, 'offset', 0, 1_000_000) ?? 0,
  };
  const text = r.optString('q', { max: 200 });
  if (text !== undefined) query.text = text;
  if (states !== undefined) query.states = states as MissionStatus[];
  const parentId = r.optString('parentId', ID);
  if (parentId !== undefined) query.parentId = parentId;
  const priority = r.optEnum('priority', PRIORITIES);
  if (priority !== undefined) query.priority = priority;
  const risk = r.optEnum('risk', RISKS);
  if (risk !== undefined) query.risk = risk;
  r.finish();
  return query;
}

export function parseActivity(params: Readonly<Record<string, string>>): {
  afterVersion: number;
  limit: number;
} {
  const r = new InputReader(params);
  const parsed = {
    afterVersion: numeric(r, 'after', 0, 2_147_483_647) ?? 0,
    limit: numeric(r, 'limit', 1, 200) ?? 50,
  };
  r.finish();
  return parsed;
}

/** Query parameters arrive as strings. Reads one as an integer in range. */
function numeric(
  r: InputReader,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const raw = r.optString(key, { max: 12 });
  if (raw === undefined) {
    return undefined;
  }
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(value) || value < min || value > max) {
    r.fail(key, `must be an integer from ${min} to ${max}`);
    return undefined;
  }
  return value;
}
