import { createApp } from '../../src/api/app.js';
import { issueToken } from '../../src/auth/tokens.js';
import type { Actor, MissionState } from '../../src/core/types.js';
import {
  createIssueService,
  githubWebhookCodec,
  ISSUE_CONTRACT,
  type IssueProvider,
  type IssueRef,
  type IssueService,
  type IssueSnapshot,
  type ProviderFailure,
  type ProviderResult,
  parseGitHubIssueUrl,
  type WebhookCodec,
} from '../../src/issues/index.js';
import { MissionDriver, mission, sequentialIds } from '../core/helpers.js';
import {
  type AuthorityHarness,
  createAuthorityHarness,
  grant,
} from '../policy/helpers.js';

export const ISSUE_URL = 'https://github.com/acme/web/issues/1';
export const ISSUE_URL_2 = 'https://github.com/acme/web/issues/2';

interface FakeIssue {
  nodeId: string;
  state: 'open' | 'closed';
  title: string;
  /** Null models a provider that would not say (the blockers endpoint answered 404 or 403). */
  blockers: number | null;
}

/** A provider the test controls. It never touches the network. */
export class FakeProvider implements IssueProvider {
  readonly id = 'github';
  readonly contract = ISSUE_CONTRACT;
  readonly webhook: WebhookCodec = githubWebhookCodec;
  issues = new Map<string, FakeIssue>();
  getCalls = 0;
  closeCalls = 0;
  /** Failures handed out one per call, before the call does anything. */
  getFailures: ProviderFailure[] = [];
  closeFailures: ProviderFailure[] = [];
  /** `accept` closes. `ignore` answers success without closing, to model a failed read-back. */
  closeBehaviour: 'accept' | 'ignore' = 'accept';
  /** Called as the provider handles a close, before it answers. */
  onClose: ((ref: IssueRef) => void) | undefined;
  /** The identity a read returns instead of the stored one, to model a transfer. */
  nodeOverride: string | undefined;

  parseUrl = parseGitHubIssueUrl;

  add(url: string, init: Partial<FakeIssue> = {}): FakeIssue {
    const ref = parseGitHubIssueUrl(url);
    if (ref === undefined) {
      throw new Error(`not a github issue url: ${url}`);
    }
    const issue: FakeIssue = {
      nodeId: `node_${ref.repo}_${ref.number}`,
      state: 'open',
      title: 'Fix the thing',
      blockers: 0,
      ...init,
    };
    this.issues.set(`${ref.repo}#${ref.number}`, issue);
    return issue;
  }

  issue(url: string): FakeIssue {
    const ref = parseGitHubIssueUrl(url);
    const found =
      ref === undefined
        ? undefined
        : this.issues.get(`${ref.repo}#${ref.number}`);
    if (found === undefined) {
      throw new Error(`unknown issue ${url}`);
    }
    return found;
  }

  async getIssue(
    ref: IssueRef,
    options?: { includeBlockers?: boolean },
  ): Promise<ProviderResult<IssueSnapshot>> {
    this.getCalls += 1;
    const failure = this.getFailures.shift();
    if (failure !== undefined) {
      return { ok: false, error: failure };
    }
    const issue = this.issues.get(`${ref.repo}#${ref.number}`);
    if (issue === undefined) {
      return {
        ok: false,
        error: { kind: 'not_found', message: 'The issue was not found' },
      };
    }
    return {
      ok: true,
      value: {
        nodeId: this.nodeOverride ?? issue.nodeId,
        repo: ref.repo,
        number: ref.number,
        state: issue.state,
        title: issue.title,
        openBlockers: options?.includeBlockers === true ? issue.blockers : null,
      },
    };
  }

  async closeIssue(
    ref: IssueRef,
  ): Promise<ProviderResult<{ commented: boolean }>> {
    this.closeCalls += 1;
    this.onClose?.(ref);
    const failure = this.closeFailures.shift();
    if (failure !== undefined) {
      return { ok: false, error: failure };
    }
    const issue = this.issues.get(`${ref.repo}#${ref.number}`);
    if (issue !== undefined && this.closeBehaviour === 'accept') {
      issue.state = 'closed';
    }
    return { ok: true, value: { commented: true } };
  }
}

export interface IssueHarness extends AuthorityHarness {
  issues: IssueService;
  github: FakeProvider;
}

export function createIssueHarness(
  options: Parameters<typeof createAuthorityHarness>[0] = {},
): IssueHarness {
  const h = createAuthorityHarness(options);
  const github = new FakeProvider();
  const issues = createIssueService({
    db: h.db,
    core: h.core,
    policy: h.authority.policy,
    providers: { github },
    clock: h.clock.now,
    newId: sequentialIds(),
  });
  return { ...h, issues, github };
}

/** `bidirectional` for acme/web, so Tower may read and, with a grant, write. */
export function configure(
  h: IssueHarness,
  mode: 'link-only' | 'observe' | 'bidirectional' = 'bidirectional',
  repo = 'acme/web',
): void {
  h.issues.setSyncConfig(h.ctx(h.owner), { provider: 'github', repo, mode });
}

/** A grant to close issues in acme/web, held by Chief of Staff and humans. */
export function grantClose(
  h: IssueHarness,
  overrides: Parameters<typeof grant>[1] = {},
) {
  return grant(h, {
    action: 'issue.close',
    resource: 'github:acme/web#*',
    scope: 'repo:acme/web',
    maxRisk: 'high',
    grantee: { kind: null, principalId: h.cos.id },
    ...overrides,
  });
}

export interface LinkSpec {
  url: string;
  classification?: 'required' | 'optional' | 'reference-only';
}

/** A mission with these links, moved to `verifying`. */
export function missionWithLinks(
  h: IssueHarness,
  links: readonly LinkSpec[] = [{ url: ISSUE_URL }],
  stage: 'draft' | 'verifying' = 'verifying',
): MissionDriver {
  const driver = MissionDriver.create(
    h,
    mission({
      risk: 'medium',
      links: links.map((l) => ({
        url: l.url,
        classification: l.classification ?? 'required',
        title: null,
      })),
    }),
  );
  if (stage === 'verifying') {
    driver.toVerifying();
  }
  return driver;
}

/** Everything the other guards need, so only the issue guard decides. */
export function completeMission(
  driver: MissionDriver,
  actor?: Actor,
): MissionState {
  driver.verifyOutcome(actor);
  return driver.go('completed', actor);
}

export const stateOf = (h: IssueHarness, id: string): string =>
  h.core.missions.getMission('ws_test', id)?.state ?? 'missing';

export const WEBHOOK_SECRET = 'whsec_test_secret';

export interface IssueApi {
  h: IssueHarness;
  owner: string;
  cos: string;
  runner: string;
  provider: string;
  call(
    token: string | undefined,
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
    // biome-ignore lint/suspicious/noExplicitAny: test responses are untyped JSON
  ): Promise<{ status: number; body: any }>;
  /** A raw request, for webhooks that sign exact bytes. */
  raw(path: string, init: RequestInit): Promise<Response>;
}

/** An app over the issue harness. Webhooks are mounted for `ws_test` unless `webhooks` is false. */
export function createIssueApi(
  options: { webhooks?: boolean; webhookActor?: string } = {},
): IssueApi {
  const h = createIssueHarness();
  const app = createApp({
    db: h.db,
    now: h.clock.now,
    core: h.core,
    authority: h.authority,
    issues: h.issues,
    issueProviders: { github: h.github },
    ...(options.webhooks === false
      ? {}
      : {
          webhooks: {
            resolve: (workspaceId: string, provider: string) =>
              workspaceId === 'ws_test' && provider === 'github'
                ? {
                    secret: WEBHOOK_SECRET,
                    actorId: options.webhookActor ?? h.provider.id,
                  }
                : undefined,
          },
        }),
  });
  const token = (actor: Actor) =>
    issueToken(h.db, { principalId: actor.id }).token;
  return {
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
    raw: (path, init) => Promise.resolve(app.request(path, init)),
  };
}
