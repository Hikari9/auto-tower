import { createApp } from '../../src/api/app.js';
import { issueToken } from '../../src/auth/tokens.js';
import type { Actor } from '../../src/core/types.js';
import {
  type Authority,
  createAuthority,
  DEFAULT_ALTERNATIVES,
  type ExpansionRequest,
} from '../../src/decisions/index.js';
import type { CreateDecisionInput } from '../../src/decisions/inputs.js';
import type { CreateRuleInput } from '../../src/policy/inputs.js';
import type { AuthorizeRequest } from '../../src/policy/types.js';
import type { SqlDatabase } from '../../src/storage/database.js';
import {
  createHarness,
  type Harness,
  MissionDriver,
  mission,
  seedFixedPrincipal,
  sequentialIds,
} from '../core/helpers.js';

export interface AuthorityHarness extends Harness {
  authority: Authority;
  provider: Actor;
  /** A second human in the same workspace. */
  other: Actor;
}

export function createAuthorityHarness(
  options: Parameters<typeof createHarness>[0] = {},
): AuthorityHarness {
  const h = createHarness(options);
  const authority = createAuthority({
    db: h.db,
    guards: h.core.guards,
    clock: h.clock.now,
    newId: sequentialIds(),
  });
  return {
    ...h,
    authority,
    provider: seedFixedPrincipal(h.db, 'prn_provider', 'provider_adapter'),
    other: seedFixedPrincipal(h.db, 'prn_other_human', 'human'),
  };
}

export function ruleInput(
  overrides: Partial<CreateRuleInput> = {},
): CreateRuleInput {
  return {
    effect: 'allow',
    action: 'deploy.staging',
    resource: 'repo:app',
    scope: 'env:staging',
    maxRisk: 'medium',
    grantee: { kind: 'chief_of_staff', principalId: null },
    limits: { maxAmount: null, missionIds: null },
    expiresAt: null,
    note: null,
    ...overrides,
  };
}

export function request(
  overrides: Partial<AuthorizeRequest> = {},
): AuthorizeRequest {
  return {
    workspace: 'ws_test',
    principal: 'prn_cos',
    action: 'deploy.staging',
    resource: 'repo:app',
    scope: 'env:staging',
    risk: 'low',
    ...overrides,
  };
}

/** Creates a rule as the owner and returns it. */
export function grant(
  h: AuthorityHarness,
  overrides: Partial<CreateRuleInput> = {},
) {
  return h.authority.policy.createRule(h.ctx(h.owner), ruleInput(overrides))
    .rule;
}

export function revoke(h: AuthorityHarness, id: string, version: number) {
  return h.authority.policy.revokeRule(h.ctx(h.owner), id, version, 'test')
    .rule;
}

export interface PacketSpec {
  title: string;
  scope?: string[];
  authorized?: boolean;
}

/**
 * A mission in `ready` with packets. An authorized packet is ready for a runner. An unauthorized
 * one is a pending branch, the kind a decision blocks.
 */
export function missionWith(
  h: AuthorityHarness,
  packets: readonly PacketSpec[],
  risk: 'low' | 'medium' | 'high' = 'medium',
): { driver: MissionDriver; ids: string[] } {
  const driver = MissionDriver.create(h, mission({ risk }));
  driver.go('ready');
  const ids: string[] = [];
  for (const spec of packets) {
    const result = h.core.missions.addPacket(
      h.ctx(),
      driver.id,
      driver.state.version,
      {
        title: spec.title,
        instructions: '',
        scope: spec.scope ?? [],
        required: true,
        dependsOn: [],
      },
    );
    driver.state = result.mission;
    const added = driver.state.packets[driver.state.packets.length - 1];
    if (added === undefined) {
      throw new Error('packet was not added');
    }
    ids.push(added.id);
    if (spec.authorized === true) {
      driver.authorize(added.id);
    }
  }
  return { driver, ids };
}

export function packetStatus(driver: MissionDriver, packetId: string) {
  const found = driver.refresh().packets.find((p) => p.id === packetId);
  return { status: found?.status, authorized: found?.authorization !== null };
}

export interface Api {
  db: SqlDatabase;
  h: AuthorityHarness;
  owner: { token: string; principalId: string };
  cos: { token: string; principalId: string };
  runner: { token: string; principalId: string };
  provider: { token: string; principalId: string };
  call(
    token: string | undefined,
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
    // biome-ignore lint/suspicious/noExplicitAny: test responses are untyped JSON
  ): Promise<{ status: number; body: any }>;
}

/**
 * An app over the harness's database, core and authority, with a token for each principal kind.
 * The tokens belong to the harness's fixed principals, so ids in events match the service tests.
 */
export function createApi(): Api {
  const h = createAuthorityHarness();
  const app = createApp({
    db: h.db,
    now: h.clock.now,
    core: h.core,
    authority: h.authority,
  });
  const token = (actor: Actor) => ({
    token: issueToken(h.db, { principalId: actor.id }).token,
    principalId: actor.id,
  });
  return {
    db: h.db,
    h,
    owner: token(h.owner),
    cos: token(h.cos),
    runner: token(h.runner),
    provider: token(h.provider),
    async call(bearer, method, path, body, headers = {}) {
      const res = await app.request(path, {
        method,
        headers: {
          ...(bearer === undefined
            ? {}
            : { authorization: `Bearer ${bearer}` }),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      return {
        status: res.status,
        body: text === '' ? undefined : JSON.parse(text),
      };
    },
  };
}

export function decisionInput(
  branches: CreateDecisionInput['branches'],
  overrides: Partial<CreateDecisionInput> = {},
): CreateDecisionInput {
  return {
    dedupeKey: 'dk-1',
    category: 'scope_expansion',
    urgency: 'normal',
    question: 'May the follow-up touch the billing module?',
    alternatives: DEFAULT_ALTERNATIVES.map((a) => ({ ...a })),
    recommendation: { alternativeId: 'approve', rationale: 'It is low risk.' },
    consequences: 'The follow-up packet may edit billing files.',
    requiredAuthority: 'human',
    evidence: ['ev:plan'],
    affectedScope: ['src/billing'],
    request: null,
    advisory: { confidencePercent: 90 },
    branches,
    ...overrides,
  };
}

export function expansion(
  h: AuthorityHarness,
  overrides: Partial<ExpansionRequest> & Pick<ExpansionRequest, 'missionId'>,
): ExpansionRequest {
  return {
    workspaceId: 'ws_test',
    requester: h.runner,
    packetId: null,
    action: 'scope.extend',
    resource: 'repo:app',
    scope: 'infra/terraform',
    risk: 'low',
    amount: null,
    question: 'May this work reach into the infra scope?',
    dedupeKey: undefined,
    category: undefined,
    urgency: 'normal',
    alternatives: DEFAULT_ALTERNATIVES.map((a) => ({ ...a })),
    recommendation: null,
    consequences: '',
    evidence: [],
    affectedScope: [],
    advisory: { confidencePercent: null },
    ...overrides,
  };
}
