/// <reference types="@cloudflare/workers-types" />
import { GitHubProvider } from './adapters/issues/github.ts';
import { IssueProviderRegistry } from './adapters/issues/registry.ts';
import { timingSafeEqual } from './domain/crypto.ts';
import { createApi, errorResponse, json } from './http/api.ts';
import { Tower } from './service/tower.ts';
import { D1Driver } from './store/d1.ts';

/**
 * Cloudflare Workers entry (not deployed by this repo; see docs/OPERATIONS.md).
 * D1 is the durable source of truth; the Cron Trigger runs the scheduler sweep.
 * Nothing here calls a hosted model: cloud AI is off in v1.
 */
export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  /** One-time setup secret for POST /api/v1/setup; unset it after initialization. */
  TOWER_SETUP_TOKEN?: string;
  [secret: string]: unknown;
}

function towerFor(env: Env): Tower {
  const secret = (name: string) => (typeof env[name] === 'string' && name !== 'TOWER_SETUP_TOKEN' ? (env[name] as string) : undefined);
  return new Tower({ db: new D1Driver(env.DB), providers: new IssueProviderRegistry([new GitHubProvider()], secret) });
}

// One Tower and API per isolate so the per-principal rate limiter keeps its buckets across requests.
let cached: { env: Env; tower: Tower; api: (req: Request) => Promise<Response> } | null = null;
function hostFor(env: Env) {
  if (!cached || cached.env !== env) {
    const tower = towerFor(env);
    cached = { env, tower, api: createApi(tower) };
  }
  return cached;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const { tower, api } = hostFor(env);
    if (url.pathname === '/api/v1/setup' && req.method === 'POST') {
      try {
        const given = req.headers.get('x-setup-token') ?? '';
        if (!env.TOWER_SETUP_TOKEN || !timingSafeEqual(given, env.TOWER_SETUP_TOKEN)) return json({ error: { code: 'unauthenticated', message: 'setup token required' } }, 401);
        const body = (await req.json()) as { workspaceName?: string; ownerName?: string };
        return json(await tower.admin.bootstrap({ workspaceName: body.workspaceName ?? 'Tower', ownerName: body.ownerName ?? 'Owner' }));
      } catch (err) {
        return errorResponse(err, {});
      }
    }
    if (url.pathname.startsWith('/api/') || url.pathname === '/mcp' || url.pathname.startsWith('/webhooks/') || url.pathname === '/healthz') {
      return api(req);
    }
    return env.ASSETS ? env.ASSETS.fetch(req as never) as unknown as Response : new Response('not found', { status: 404 });
  },

  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(towerFor(env).scheduler.sweep().then(() => undefined));
  },
};
