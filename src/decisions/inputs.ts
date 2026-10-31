import { RISKS } from '../core/types.js';
import { InputReader, LIMITS, readRefs } from '../core/validation.js';
import { ACTION_PATTERN } from '../policy/actions.js';
import { readNested } from '../policy/inputs.js';
import { MAX_PATTERN_LENGTH } from '../policy/patterns.js';
import {
  type Advisory,
  type Alternative,
  type Branch,
  DECISION_CATEGORIES,
  DEFAULT_ALTERNATIVES,
  type DecisionCategory,
  type DecisionRequest,
  REQUIRED_AUTHORITIES,
  type RequiredAuthority,
  URGENCIES,
  type Urgency,
} from './types.js';

const ID = { max: 128, min: 1 } as const;
const TEXT = { max: 2_000 } as const;
const MAX_BRANCHES = 20;
const MAX_ALTERNATIVES = 8;
const PATTERN = { max: MAX_PATTERN_LENGTH, min: 1 } as const;

export interface RecommendationInput {
  alternativeId: string | null;
  rationale: string;
}

export interface CreateDecisionInput {
  dedupeKey: string;
  category: DecisionCategory;
  urgency: Urgency;
  question: string;
  alternatives: Alternative[];
  recommendation: RecommendationInput | null;
  consequences: string;
  requiredAuthority: RequiredAuthority;
  evidence: string[];
  affectedScope: string[];
  request: DecisionRequest | null;
  advisory: Advisory;
  branches: Branch[];
}

export interface AnswerInput {
  version: number;
  choice: string;
  note: string | null;
}

export interface ExpansionInput {
  missionId: string;
  packetId: string | null;
  action: string;
  resource: string;
  scope: string;
  risk: DecisionRequest['risk'];
  amount: number | null;
  question: string;
  dedupeKey: string | undefined;
  category: DecisionCategory | undefined;
  urgency: Urgency;
  alternatives: Alternative[];
  recommendation: RecommendationInput | null;
  consequences: string;
  evidence: string[];
  affectedScope: string[];
  advisory: Advisory;
}

function readAlternative(item: InputReader): Alternative {
  return {
    id: item.string('id', { max: 64, min: 1 }),
    label: item.string('label', { max: 200, min: 1 }),
    description: item.optNullableString('description', TEXT) ?? null,
    consequence: item.optNullableString('consequence', TEXT) ?? null,
    resumes: item.optBoolean('resumes') ?? false,
  };
}

function readAlternatives(r: InputReader): Alternative[] {
  const given = r.optItems('alternatives', MAX_ALTERNATIVES, readAlternative);
  if (given === undefined) {
    return DEFAULT_ALTERNATIVES.map((a) => ({ ...a }));
  }
  const seen = new Set<string>();
  for (const alt of given) {
    if (seen.has(alt.id)) {
      r.fail('alternatives', `lists ${alt.id} more than once`);
    }
    seen.add(alt.id);
  }
  if (given.length < 2) {
    r.fail('alternatives', 'needs at least two choices');
  }
  return given;
}

function readRecommendation(item: InputReader): RecommendationInput {
  return {
    alternativeId: item.optNullableString('alternativeId', ID) ?? null,
    rationale: item.string('rationale', { max: 2_000, min: 1 }),
  };
}

function readRequest(item: InputReader): DecisionRequest {
  const action = item.string('action', { max: 128, min: 1 });
  if (!ACTION_PATTERN.test(action)) {
    item.fail('action', 'must be lower-case dotted segments');
  }
  return {
    action,
    resource: item.string('resource', PATTERN),
    scope: item.string('scope', PATTERN),
    risk: item.enum('risk', RISKS),
    amount: item.optInteger('amount', { min: 0, max: 1e12 }) ?? null,
  };
}

function readAdvisory(item: InputReader): Advisory {
  return {
    confidencePercent:
      item.optInteger('confidencePercent', { min: 0, max: 100 }) ?? null,
  };
}

function readBranch(item: InputReader): Branch {
  return {
    missionId: item.string('missionId', ID),
    packetId: item.optNullableString('packetId', ID) ?? null,
  };
}

/** Reads the nested objects with their own readers, leaving the rest for the main one. */
function nestedFields(body: unknown, withRequest: boolean) {
  const issues = new InputReader({});
  const recommendation = readNested(
    issues,
    body,
    'recommendation',
    readRecommendation,
  );
  const advisory = readNested(
    issues,
    recommendation.rest,
    'advisory',
    readAdvisory,
  );
  const request = withRequest
    ? readNested(issues, advisory.rest, 'request', readRequest)
    : { rest: advisory.rest, value: undefined };
  return {
    issues,
    rest: request.rest,
    recommendation: recommendation.value ?? null,
    advisory: advisory.value ?? { confidencePercent: null },
    request: request.value ?? null,
  };
}

function carry(from: InputReader, to: InputReader): void {
  for (const issue of from.finishIssues()) {
    to.fail(issue.path, issue.message);
  }
}

function checkRecommendation(
  r: InputReader,
  recommendation: RecommendationInput | null,
  alternatives: readonly Alternative[],
): void {
  const id = recommendation?.alternativeId;
  if (
    id !== undefined &&
    id !== null &&
    !alternatives.some((a) => a.id === id)
  ) {
    r.fail('recommendation.alternativeId', 'is not one of the alternatives');
  }
}

export function parseCreateDecision(body: unknown): CreateDecisionInput {
  const { rest, issues, recommendation, advisory, request } = nestedFields(
    body,
    true,
  );
  const r = new InputReader(rest);
  carry(issues, r);
  const alternatives = readAlternatives(r);
  checkRecommendation(r, recommendation, alternatives);
  const branches = r.optItems('branches', MAX_BRANCHES, readBranch) ?? [];
  if (branches.length === 0 && !r.has('branches')) {
    r.fail('branches', 'is required');
  } else if (branches.length === 0) {
    r.fail('branches', 'needs at least one branch');
  }
  const input: CreateDecisionInput = {
    dedupeKey: r.string('dedupeKey', { max: 200, min: 1 }),
    category: r.enum('category', DECISION_CATEGORIES),
    urgency: r.optEnum('urgency', URGENCIES) ?? 'normal',
    question: r.string('question', { max: LIMITS.text, min: 1 }),
    alternatives,
    recommendation,
    consequences: r.optString('consequences', { max: LIMITS.text }) ?? '',
    requiredAuthority:
      r.optEnum('requiredAuthority', REQUIRED_AUTHORITIES) ?? 'human',
    evidence: readRefs(r, 'evidence'),
    affectedScope:
      r.optStrings('affectedScope', {
        maxItems: LIMITS.scopeItems,
        maxLength: LIMITS.listItem,
        minLength: 1,
      }) ?? [],
    request,
    advisory,
    branches,
  };
  r.finish();
  return input;
}

export function parseAnswer(body: unknown): AnswerInput {
  const r = new InputReader(body);
  const input: AnswerInput = {
    version: r.integer('version', { min: 1, max: 1_000_000 }),
    choice: r.string('choice', { max: 64, min: 1 }),
    note: r.optNullableString('note', { max: LIMITS.reason }) ?? null,
  };
  r.finish();
  return input;
}

export function parseExpansion(body: unknown): ExpansionInput {
  const { rest, issues, recommendation, advisory } = nestedFields(body, false);
  const r = new InputReader(rest);
  carry(issues, r);
  const alternatives = readAlternatives(r);
  checkRecommendation(r, recommendation, alternatives);
  const action = r.string('action', { max: 128, min: 1 });
  if (!ACTION_PATTERN.test(action)) {
    r.fail('action', 'must be lower-case dotted segments');
  }
  const input: ExpansionInput = {
    missionId: r.string('missionId', ID),
    packetId: r.optNullableString('packetId', ID) ?? null,
    action,
    resource: r.string('resource', PATTERN),
    scope: r.string('scope', PATTERN),
    risk: r.enum('risk', RISKS),
    amount: r.optInteger('amount', { min: 0, max: 1e12 }) ?? null,
    question: r.string('question', { max: LIMITS.text, min: 1 }),
    dedupeKey: r.optString('dedupeKey', { max: 200, min: 1 }),
    category: r.optEnum('category', DECISION_CATEGORIES),
    urgency: r.optEnum('urgency', URGENCIES) ?? 'normal',
    alternatives,
    recommendation,
    consequences: r.optString('consequences', { max: LIMITS.text }) ?? '',
    evidence: readRefs(r, 'evidence'),
    affectedScope:
      r.optStrings('affectedScope', {
        maxItems: LIMITS.scopeItems,
        maxLength: LIMITS.listItem,
        minLength: 1,
      }) ?? [],
    advisory,
  };
  r.finish();
  return input;
}

export function parseDecisionFilter(query: Readonly<Record<string, string>>): {
  status: 'open' | 'answered' | 'all';
  limit: number;
} {
  const r = new InputReader(query);
  const status = r.optEnum('status', ['open', 'answered', 'all'] as const);
  const limitText = r.optString('limit', { max: 4 });
  const limit = limitText === undefined ? 50 : Number(limitText);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    r.fail('limit', 'must be an integer from 1 to 200');
  }
  r.finish();
  return { status: status ?? 'open', limit };
}
