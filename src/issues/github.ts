import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  cleanUntrustedText,
  ISSUE_CONTRACT,
  type IssueProvider,
  type IssueRef,
  type IssueSnapshot,
  type ProviderFailure,
  type ProviderResult,
  type WebhookCodec,
  type WebhookObservation,
} from './provider.js';
import { parsePublicHttpsUrl } from './url.js';

export const GITHUB_API_BASE = 'https://api.github.com';
const MAX_BODY_BYTES = 1_000_000;
const MAX_RETRY_SECONDS = 86_400;
const DEFAULT_RETRY_SECONDS = 60;
const DEFAULT_TIMEOUT_MS = 10_000;
const TITLE_MAX = 500;

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const MARKER = /tower:origin:([A-Za-z0-9_]{1,80})/;

export interface GitHubProviderOptions {
  /** Supplies the credential at call time. Tower never stores it, and it is never logged. */
  token: () => string | Promise<string>;
  fetch?: typeof fetch;
  apiBase?: string;
  timeoutMs?: number;
}

/** Owner and repository as GitHub allows them, so neither can add path segments or `..`. */
function validRepoParts(owner: string, name: string): boolean {
  return OWNER.test(owner) && REPO.test(name) && name !== '.' && name !== '..';
}

/** `https://github.com/<owner>/<repo>/issues/<n>`, nothing else. */
export function parseGitHubIssueUrl(raw: string): IssueRef | undefined {
  const parsed = parsePublicHttpsUrl(raw);
  if (!parsed.ok || parsed.url.hostname.toLowerCase() !== 'github.com') {
    return undefined;
  }
  const match = /^\/([^/]+)\/([^/]+)\/issues\/([1-9]\d{0,9})\/?$/.exec(
    parsed.url.pathname,
  );
  const owner = match?.[1];
  const name = match?.[2];
  const number = match?.[3];
  if (
    owner === undefined ||
    name === undefined ||
    number === undefined ||
    !validRepoParts(owner, name)
  ) {
    return undefined;
  }
  return {
    provider: 'github',
    repo: `${owner}/${name}`.toLowerCase(),
    number: Number(number),
    url: `https://github.com/${owner}/${name}/issues/${number}`,
  };
}

/** Constant-time check of `X-Hub-Signature-256` over the raw bytes. */
export function verifyGitHubSignature(
  secret: string,
  rawBody: Uint8Array,
  header: string | null,
): boolean {
  if (secret === '' || header === null) {
    return false;
  }
  const match = /^sha256=([0-9a-f]{64})$/.exec(header);
  if (match?.[1] === undefined) {
    return false;
  }
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(match[1], 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function signGitHubBody(secret: string, rawBody: Uint8Array): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

function repoOfPayload(payload: Record<string, unknown>): string | undefined {
  const full = asString(asRecord(payload.repository)?.full_name);
  if (full === undefined) {
    return undefined;
  }
  const [owner, name, extra] = full.split('/');
  return owner !== undefined &&
    name !== undefined &&
    extra === undefined &&
    validRepoParts(owner, name)
    ? full.toLowerCase()
    : undefined;
}

export const githubWebhookCodec: WebhookCodec = {
  verify: (secret, rawBody, headers) =>
    verifyGitHubSignature(secret, rawBody, headers.get('x-hub-signature-256')),

  deliveryId(headers) {
    const id = headers.get('x-github-delivery');
    return id !== null && /^[A-Za-z0-9-]{1,100}$/.test(id) ? id : undefined;
  },

  decode(headers, body): WebhookObservation | undefined {
    const event = headers.get('x-github-event');
    if (event === 'ping') {
      return { kind: 'ping' };
    }
    const payload = asRecord(body);
    if (payload === undefined) {
      return undefined;
    }
    const repo = repoOfPayload(payload);
    const issue = asRecord(payload.issue);
    const number = issue?.number;
    if (
      repo === undefined ||
      issue === undefined ||
      typeof number !== 'number' ||
      !Number.isInteger(number) ||
      number < 1 ||
      issue.pull_request !== undefined
    ) {
      return undefined;
    }
    if (event === 'issue_comment') {
      const comment = asRecord(payload.comment);
      const found = MARKER.exec(asString(comment?.body) ?? '');
      return { kind: 'comment', repo, number, marker: found?.[1] ?? null };
    }
    if (event !== 'issues') {
      return undefined;
    }
    const action = asString(payload.action);
    if (action === undefined) {
      return undefined;
    }
    const state =
      issue.state === 'open' || issue.state === 'closed' ? issue.state : null;
    const title = asString(issue.title);
    return {
      kind: 'issue',
      action,
      repo,
      number,
      nodeId: asString(issue.node_id) ?? null,
      state,
      title: title === undefined ? null : cleanUntrustedText(title, TITLE_MAX),
      identityLost: action === 'transferred' || action === 'deleted',
    };
  },
};

function fail(
  kind: ProviderFailure['kind'],
  message: string,
  retryAfterSeconds?: number,
): { ok: false; error: ProviderFailure } {
  return {
    ok: false,
    error: {
      kind,
      message,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    },
  };
}

function retryAfterSeconds(headers: Headers, now: number): number {
  const header = headers.get('retry-after');
  if (header !== null) {
    if (/^\d+$/.test(header)) {
      return Math.min(Number(header), MAX_RETRY_SECONDS);
    }
    const at = Date.parse(header);
    if (!Number.isNaN(at)) {
      return Math.min(
        Math.max(Math.ceil((at - now) / 1000), 1),
        MAX_RETRY_SECONDS,
      );
    }
  }
  const reset = headers.get('x-ratelimit-reset');
  if (
    headers.get('x-ratelimit-remaining') === '0' &&
    reset !== null &&
    /^\d+$/.test(reset)
  ) {
    return Math.min(
      Math.max(Number(reset) - Math.ceil(now / 1000), 1),
      MAX_RETRY_SECONDS,
    );
  }
  return DEFAULT_RETRY_SECONDS;
}

/** Reads at most `MAX_BODY_BYTES` of a response body as text. */
async function readText(response: Response): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return '';
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The GitHub provider. It only ever calls `apiBase`, built from a parsed owner, repository and
 * number, and it never follows a redirect, so a stored URL cannot steer a request elsewhere.
 */
export function createGitHubProvider(
  options: GitHubProviderOptions,
): IssueProvider {
  const base = new URL(options.apiBase ?? GITHUB_API_BASE);
  if (options.apiBase !== undefined) {
    // A custom API host (GitHub Enterprise) is checked like any link, apart from tests that
    // inject `fetch` and use a name that never resolves.
    const checked = parsePublicHttpsUrl(options.apiBase);
    if (!checked.ok) {
      throw new Error(`GitHub API base ${checked.message}`);
    }
  }
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  function endpoint(ref: IssueRef, suffix = ''): string {
    const [owner, name] = ref.repo.split('/');
    return `${base.origin}/repos/${encodeURIComponent(owner ?? '')}/${encodeURIComponent(name ?? '')}/issues/${ref.number}${suffix}`;
  }

  async function call(
    method: 'GET' | 'PATCH' | 'POST',
    url: string,
    body?: unknown,
  ): Promise<ProviderResult<{ status: number; json: unknown }>> {
    let token: string;
    try {
      token = await options.token();
    } catch {
      return fail('permission', 'The provider credential is not available');
    }
    let response: Response;
    try {
      response = await doFetch(url, {
        method,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'user-agent': 'auto-tower',
          'x-github-api-version': '2022-11-28',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      return fail('unavailable', 'The provider could not be reached');
    }
    const status = response.status;
    if ((status >= 300 && status < 400) || response.type === 'opaqueredirect') {
      return fail('transferred', 'The issue moved or was transferred');
    }
    if (status === 404 || status === 410) {
      return fail('not_found', 'The issue was not found');
    }
    if (status === 401) {
      return fail('permission', 'The provider rejected the credential');
    }
    if (status === 429) {
      return fail(
        'rate_limited',
        'The provider rate limit was reached',
        retryAfterSeconds(response.headers, Date.now()),
      );
    }
    const text = await readText(response);
    if (status === 403) {
      const limited =
        response.headers.has('retry-after') ||
        response.headers.get('x-ratelimit-remaining') === '0' ||
        /rate limit/i.test(text ?? '');
      return limited
        ? fail(
            'rate_limited',
            'The provider rate limit was reached',
            retryAfterSeconds(response.headers, Date.now()),
          )
        : fail('permission', 'The credential may not do this');
    }
    if (status >= 500) {
      return fail('unavailable', 'The provider is not available');
    }
    if (status < 200 || status >= 300) {
      return fail('invalid_response', 'The provider refused the request');
    }
    if (text === undefined) {
      return fail('invalid_response', 'The provider response was too large');
    }
    if (text === '') {
      return { ok: true, value: { status, json: null } };
    }
    try {
      return { ok: true, value: { status, json: JSON.parse(text) as unknown } };
    } catch {
      return fail('invalid_response', 'The provider response was not JSON');
    }
  }

  /** Null when the endpoint is missing (404) or closed to this credential (403): unknown, not zero. */
  async function openBlockers(
    ref: IssueRef,
  ): Promise<ProviderResult<number | null>> {
    const result = await call(
      'GET',
      `${endpoint(ref, '/dependencies/blocked_by')}?per_page=100`,
    );
    if (!result.ok) {
      return result.error.kind === 'not_found' ||
        result.error.kind === 'permission'
        ? { ok: true, value: null }
        : result;
    }
    const list = result.value.json;
    if (!Array.isArray(list)) {
      return fail('invalid_response', 'The blockers response was not a list');
    }
    const open = list.filter(
      (item) => asRecord(item)?.state !== 'closed',
    ).length;
    return { ok: true, value: open };
  }

  return {
    id: 'github',
    contract: ISSUE_CONTRACT,
    parseUrl: parseGitHubIssueUrl,
    webhook: githubWebhookCodec,

    async getIssue(ref, opts) {
      const result = await call('GET', endpoint(ref));
      if (!result.ok) {
        return result;
      }
      const issue = asRecord(result.value.json);
      const nodeId = asString(issue?.node_id);
      const state = issue?.state;
      const title = typeof issue?.title === 'string' ? issue.title : '';
      const repoUrl = asString(issue?.repository_url);
      const repoTail = repoUrl?.toLowerCase().split('/repos/')[1];
      if (
        issue === undefined ||
        nodeId === undefined ||
        (state !== 'open' && state !== 'closed') ||
        issue.number !== ref.number ||
        issue.pull_request !== undefined ||
        repoTail === undefined
      ) {
        return fail(
          'invalid_response',
          'The issue response was not what was asked for',
        );
      }
      if (repoTail !== ref.repo) {
        return fail('transferred', 'The issue moved or was transferred');
      }
      let blockers: number | null = null;
      if (opts?.includeBlockers === true) {
        const counted = await openBlockers(ref);
        if (!counted.ok) {
          return counted;
        }
        blockers = counted.value;
      }
      const snapshot: IssueSnapshot = {
        nodeId,
        repo: ref.repo,
        number: ref.number,
        state,
        title: cleanUntrustedText(title, TITLE_MAX),
        openBlockers: blockers,
      };
      return { ok: true, value: snapshot };
    },

    async closeIssue(ref, request) {
      const closed = await call('PATCH', endpoint(ref), {
        state: 'closed',
        state_reason: 'completed',
      });
      if (!closed.ok) {
        return closed;
      }
      // The note is for people reading the issue. The close does not depend on it.
      const note = await call('POST', endpoint(ref, '/comments'), {
        body: `${request.note}\n\n<!-- tower:origin:${request.marker} -->`,
      });
      return { ok: true, value: { commented: note.ok } };
    },
  };
}
