import { hmacSha256Hex, timingSafeEqual } from '../../domain/crypto.ts';
import { ISSUE_PROVIDER_CONTRACT, ProviderError, type IssueProvider, type IssueSnapshot, type ProviderContext, type VerifiedWebhook, type WebhookObservation } from './contract.ts';

export interface GitHubRepoConfig {
  repo: string;
  read: boolean;
  write: boolean;
}

export interface GitHubConfig {
  repos: GitHubRepoConfig[];
  /** link: store links only; observe: read state; bidirectional: also close under grants. */
  syncMode: 'link' | 'observe' | 'bidirectional';
  /** Names of secrets in the host's secret store. Values are never stored in Tower's database. */
  tokenSecret: string;
  webhookSecret?: string;
  apiBase?: string;
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const MARKER_RE = /<!-- auto-tower:effect=([A-Za-z0-9_-]+) -->/;

/** Optional GitHub provider. Issue-level only; GitHub stays the authority for its issues. */
export class GitHubProvider implements IssueProvider {
  readonly id = 'github';
  readonly contract = ISSUE_PROVIDER_CONTRACT;
  private readonly fetch: Fetch;

  constructor(opts: { fetch?: Fetch } = {}) {
    this.fetch = opts.fetch ?? ((i, init) => fetch(i, init));
  }

  parse(url: URL): { ref: string; repo: string } | null {
    if (url.hostname !== 'github.com') return null;
    const m = url.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(?:issues|pull)\/(\d+)\/?$/);
    if (!m) return null;
    const repo = `${m[1]}/${m[2]}`.toLowerCase();
    return { ref: `${repo}#${m[3]}`, repo };
  }

  private cfg(ctx: ProviderContext): GitHubConfig {
    return ctx.config as unknown as GitHubConfig;
  }

  private async call(ctx: ProviderContext, method: string, path: string, body?: unknown): Promise<unknown> {
    const cfg = this.cfg(ctx);
    const token = ctx.secret(cfg.tokenSecret);
    if (!token) throw new ProviderError('auth', `secret ${cfg.tokenSecret} is not configured`);
    let res: Response;
    try {
      res = await this.fetch(`${cfg.apiBase ?? 'https://api.github.com'}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          'user-agent': 'auto-tower',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new ProviderError('unavailable', `GitHub unreachable: ${(err as Error).message}`);
    }
    if (res.ok) return res.status === 204 ? null : res.json();
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (res.status === 429 || (res.status === 403 && remaining === '0')) {
      const reset = res.headers.get('x-ratelimit-reset');
      const retryAfter = res.headers.get('retry-after');
      const at = reset ? new Date(Number(reset) * 1000) : new Date(Date.now() + Number(retryAfter ?? 60) * 1000);
      throw new ProviderError('rate_limited', 'GitHub rate limit reached', at.toISOString());
    }
    if (res.status === 401) throw new ProviderError('auth', 'GitHub rejected the credentials');
    if (res.status === 403) throw new ProviderError('forbidden', 'GitHub denied access to this resource');
    if (res.status === 404 || res.status === 410) throw new ProviderError('not_found', 'issue not found or not visible to these credentials');
    if (res.status === 422) throw new ProviderError('invalid', 'GitHub rejected the request');
    throw new ProviderError('unavailable', `GitHub returned ${res.status}`);
  }

  async read(ref: string, ctx: ProviderContext): Promise<IssueSnapshot> {
    const { repo, number } = splitRef(ref);
    const j = (await this.call(ctx, 'GET', `/repos/${repo}/issues/${number}`)) as {
      state: string;
      title: string;
      body: string | null;
      html_url: string;
      labels: ({ name: string } | string)[];
      locked: boolean;
      updated_at: string | null;
    };
    const canonical = this.parse(new URL(j.html_url));
    return {
      canonicalRef: canonical?.ref ?? ref,
      url: j.html_url,
      state: j.state === 'closed' ? 'closed' : 'open',
      title: j.title ?? '',
      body: j.body ?? '',
      labels: (j.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)),
      locked: Boolean(j.locked),
      updatedAt: j.updated_at ?? null,
    };
  }

  async close(ref: string, ctx: ProviderContext, opts: { comment: string; marker: string }): Promise<void> {
    const cfg = this.cfg(ctx);
    const { repo, number } = splitRef(ref);
    const rc = cfg.repos.find((r) => r.repo.toLowerCase() === repo);
    if (cfg.syncMode !== 'bidirectional' || !rc?.write) throw new ProviderError('forbidden', `write access to ${repo} is not enabled for Tower`);
    const current = await this.read(ref, ctx);
    if (current.state === 'closed') return;
    await this.call(ctx, 'PATCH', `/repos/${repo}/issues/${number}`, { state: 'closed', state_reason: 'completed' });
    try {
      await this.call(ctx, 'POST', `/repos/${repo}/issues/${number}/comments`, { body: `${opts.comment}\n\n<!-- auto-tower:effect=${opts.marker} -->` });
    } catch {
      // The close is the effect; the comment is courtesy. Read-back decides success.
    }
  }

  async verifyWebhook(headers: Headers, rawBody: string, ctx: ProviderContext): Promise<VerifiedWebhook> {
    const cfg = this.cfg(ctx);
    const secret = cfg.webhookSecret ? ctx.secret(cfg.webhookSecret) : undefined;
    if (!secret) throw new ProviderError('auth', 'webhook secret is not configured');
    const sig = headers.get('x-hub-signature-256') ?? '';
    const expected = `sha256=${await hmacSha256Hex(secret, rawBody)}`;
    if (!timingSafeEqual(sig, expected)) throw new ProviderError('auth', 'invalid webhook signature');
    const deliveryId = headers.get('x-github-delivery');
    if (!deliveryId) throw new ProviderError('invalid', 'missing delivery id');
    const event = headers.get('x-github-event');
    const observations: WebhookObservation[] = [];
    if (event === 'issues' || event === 'issue_comment') {
      const p = JSON.parse(rawBody) as { action: string; issue?: { number: number; state: string; title: string }; repository?: { full_name: string }; comment?: { body?: string } };
      if (p.issue && p.repository) {
        const ref = `${p.repository.full_name.toLowerCase()}#${p.issue.number}`;
        const state: WebhookObservation['state'] =
          p.action === 'deleted' ? 'deleted' : p.action === 'transferred' ? 'transferred' : p.issue.state === 'closed' ? 'closed' : 'open';
        const marker = p.comment?.body?.match(MARKER_RE)?.[1];
        observations.push({ ref, state, action: p.action, title: p.issue.title, ...(marker ? { towerOrigin: marker } : {}) });
      }
    }
    return { deliveryId, observations };
  }
}

function splitRef(ref: string): { repo: string; number: number } {
  const m = ref.match(/^([a-z0-9_.-]+\/[a-z0-9_.-]+)#(\d+)$/);
  if (!m) throw new ProviderError('invalid', `bad GitHub reference ${ref}`);
  return { repo: m[1]!, number: Number(m[2]) };
}
