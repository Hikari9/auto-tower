import { ZodError, type ZodType } from 'zod';
import { TowerError } from '../domain/errors.ts';
import type { Actor, MissionState } from '../domain/types.ts';
import type { Tower } from '../service/tower.ts';
import { handleMcp } from './mcp.ts';
import * as S from './schemas.ts';

type Ctx = { req: Request; params: Record<string, string>; url: URL; actor: Actor; body: () => Promise<unknown>; idem: string | undefined };
type Handler = (c: Ctx) => Promise<unknown>;
interface Route {
  method: string;
  re: RegExp;
  keys: string[];
  handler: Handler;
}

const MAX_BODY = 1_000_000;

export interface ApiOptions {
  /** Per-principal request budget per minute (per isolate). Protects free-tier quotas from retry storms. */
  ratePerMinute?: number;
}

/**
 * HTTP API. One backend for the dashboard, MCP clients and runners; every route
 * authenticates and authorizes at this boundary through the Tower services.
 */
export function createApi(tower: Tower, opts: ApiOptions = {}) {
  const routes: Route[] = [];
  const add = (method: string, path: string, handler: Handler) => {
    const keys: string[] = [];
    const re = new RegExp(`^${path.replace(/:([a-zA-Z]+)/g, (_, k: string) => (keys.push(k), '([^/]+)'))}$`);
    routes.push({ method, re, keys, handler });
  };
  const parse = async <T>(c: Ctx, schema: ZodType<T>): Promise<T> => schema.parse(await c.body());
  const t = tower;

  add('GET', '/api/v1/me', async (c) => ({ principal: c.actor.principal, workspace: await t.repo.workspace(c.actor.principal.workspaceId) }));
  add('GET', '/api/v1/health', (c) => t.admin.health(c.actor));
  add('GET', '/api/v1/activity', (c) =>
    t.admin.activity(c.actor, {
      ...(c.url.searchParams.get('after') ? { afterSeq: Number(c.url.searchParams.get('after')) } : {}),
      ...(c.url.searchParams.get('missionId') ? { missionId: c.url.searchParams.get('missionId')! } : {}),
      limit: Number(c.url.searchParams.get('limit') ?? 100),
    }),
  );

  // Missions
  add('GET', '/api/v1/missions', (c) => {
    const states = c.url.searchParams.get('state')?.split(',').filter(Boolean) as MissionState[] | undefined;
    const q = c.url.searchParams.get('q');
    return t.missions.list(c.actor, { ...(states?.length ? { states } : {}), ...(q ? { q } : {}) });
  });
  add('POST', '/api/v1/missions', async (c) => t.missions.create(c.actor, stripUndefined(await parse(c, S.MissionCreate)), c.idem));
  add('GET', '/api/v1/missions/:id', (c) => t.missions.get(c.actor, c.params.id!));
  add('PATCH', '/api/v1/missions/:id', async (c) => {
    const { expectedVersion, ...patch } = await parse(c, S.MissionPatch);
    return t.missions.update(c.actor, c.params.id!, expectedVersion, stripUndefined(patch));
  });
  add('POST', '/api/v1/missions/:id/start', (c) => t.missions.start(c.actor, c.params.id!));
  add('POST', '/api/v1/missions/:id/pause', async (c) => t.missions.pause(c.actor, c.params.id!, (await parse(c, S.Reason)).reason));
  add('POST', '/api/v1/missions/:id/resume', (c) => t.missions.resume(c.actor, c.params.id!));
  add('POST', '/api/v1/missions/:id/cancel', async (c) => t.missions.cancel(c.actor, c.params.id!, (await parse(c, S.Reason)).reason));
  add('POST', '/api/v1/missions/:id/verify', async (c) => t.missions.verify(c.actor, c.params.id!, stripUndefined(await parse(c, S.Verify))));
  add('POST', '/api/v1/missions/:id/reconcile', async (c) => {
    requireWrite(c.actor);
    return t.missions.refresh(c.actor.principal.workspaceId, (await t.missions.get(c.actor, c.params.id!)).mission.id);
  });
  add('POST', '/api/v1/missions/:id/packets', async (c) => t.missions.addPacket(c.actor, c.params.id!, stripUndefined(await parse(c, S.PacketInput)), c.idem));
  add('POST', '/api/v1/missions/:id/links', async (c) => t.issues.addLink(c.actor, c.params.id!, stripUndefined(await parse(c, S.LinkInput))));
  add('POST', '/api/v1/missions/:id/decisions', async (c) => t.decisions.raise(c.actor, { ...stripUndefined(await parse(c, S.RaiseDecision)), missionId: c.params.id! }));
  add('GET', '/api/v1/missions/:id/dispatch-preview', (c) => t.runners.previewDispatch(c.actor, c.params.id!));

  // Packets and links
  for (const action of ['pause', 'resume', 'cancel', 'retry'] as const) add('POST', `/api/v1/packets/:id/${action}`, (c) => t.runners.packetControl(c.actor, c.params.id!, action));
  add('POST', '/api/v1/links/:id/attest', async (c) => {
    const b = await parse(c, S.Attest);
    return t.issues.attest(c.actor, c.params.id!, b.state, b.note);
  });
  add('POST', '/api/v1/links/:id/exempt', async (c) => t.issues.exempt(c.actor, c.params.id!, (await parse(c, S.Reason)).reason));
  add('POST', '/api/v1/links/:id/role', async (c) => t.issues.setRole(c.actor, c.params.id!, (await parse(c, S.SetRole)).role));

  // Decisions
  add('GET', '/api/v1/decisions', (c) =>
    t.decisions.list(c.actor, {
      status: c.url.searchParams.get('status') ?? 'open',
      ...(c.url.searchParams.get('audience') ? { audience: c.url.searchParams.get('audience')! } : {}),
      ...(c.url.searchParams.get('missionId') ? { missionId: c.url.searchParams.get('missionId')! } : {}),
    }),
  );
  add('GET', '/api/v1/decisions/:id', (c) => t.decisions.get(c.actor, c.params.id!));
  add('POST', '/api/v1/decisions/:id/answer', async (c) => t.decisions.answer(c.actor, c.params.id!, stripUndefined(await parse(c, S.Answer)), c.idem));
  add('POST', '/api/v1/decisions/:id/escalate', async (c) => t.decisions.escalate(c.actor, c.params.id!, (await parse(c, S.Reason)).reason));

  // Policy
  add('GET', '/api/v1/policy', (c) => t.policy.list(c.actor));
  add('POST', '/api/v1/policy/rules', async (c) => t.policy.grant(c.actor, stripUndefined(await parse(c, S.Grant)), c.idem));
  add('POST', '/api/v1/policy/rules/:id/revoke', async (c) => t.policy.revoke(c.actor, c.params.id!, (await parse(c, S.Reason)).reason));
  add('POST', '/api/v1/policy/rules/:id/amend', async (c) => t.policy.amend(c.actor, c.params.id!, stripUndefined(await parse(c, S.Amend))));
  add('POST', '/api/v1/policy/proposals', async (c) => t.policy.propose(c.actor, stripUndefined(await parse(c, S.Propose))));
  add('POST', '/api/v1/policy/proposals/:id/accept', async (c) => t.policy.acceptProposal(c.actor, c.params.id!, stripUndefined(S.Amend.parse((await c.body()) ?? {}))));
  add('POST', '/api/v1/policy/proposals/:id/decline', (c) => t.policy.declineProposal(c.actor, c.params.id!));
  add('PUT', '/api/v1/policy/preferences/:key', async (c) => {
    await t.policy.setPreference(c.actor, decodeURIComponent(c.params.key!), ((await c.body()) as { value?: unknown })?.value ?? null);
    return { ok: true };
  });

  // Fleet
  add('GET', '/api/v1/runners', (c) => t.runners.list(c.actor));
  add('POST', '/api/v1/runners/:id/quarantine', async (c) => t.runners.quarantine(c.actor, c.params.id!, (await parse(c, S.Quarantine)).reason));
  add('POST', '/api/v1/runners/:id/release', (c) => t.runners.release(c.actor, c.params.id!));

  // Runner protocol (tower.runner/v1)
  add('POST', '/api/v1/runner/register', async (c) => t.runners.register(c.actor, await c.body()));
  add('POST', '/api/v1/runner/heartbeat', async (c) => t.runners.heartbeat(c.actor, await c.body()));
  add('POST', '/api/v1/runner/claim', async (c) => ({ claim: await t.runners.claim(c.actor) }));
  add('POST', '/api/v1/runner/receipts', async (c) => t.runners.report(c.actor, await c.body()));
  add('POST', '/api/v1/runner/effects', async (c) => t.runners.authorizeEffect(c.actor, await c.body()));
  add('POST', '/api/v1/runner/followups', async (c) => t.runners.createFollowup(c.actor, await c.body()));
  add('POST', '/api/v1/runner/expansions', async (c) => t.runners.requestExpansion(c.actor, await c.body()));

  // Integrations and admin
  add('GET', '/api/v1/integrations', (c) => t.issues.listIntegrations(c.actor));
  add('PUT', '/api/v1/integrations/:provider', async (c) => {
    const b = await parse(c, S.Integration);
    return t.issues.configure(c.actor, c.params.provider!, b.config, b.enabled);
  });
  add('GET', '/api/v1/admin/principals', (c) => t.admin.listPrincipals(c.actor));
  add('POST', '/api/v1/admin/tokens', async (c) => t.admin.issueToken(c.actor, stripUndefined(await parse(c, S.IssueToken))));
  add('POST', '/api/v1/admin/principals/:id/rotate', (c) => t.admin.rotateToken(c.actor, c.params.id!));
  add('POST', '/api/v1/admin/principals/:id/revoke', async (c) => (await t.admin.revokePrincipal(c.actor, c.params.id!), { ok: true }));
  add('POST', '/api/v1/admin/halt', async (c) => {
    const b = await parse(c, S.Halt);
    return t.admin.setHalt(c.actor, b.halted, b.reason);
  });
  add('PUT', '/api/v1/admin/flags/:key', async (c) => (await t.admin.setFlag(c.actor, c.params.key!, ((await c.body()) ?? {}) as Record<string, unknown>), { ok: true }));
  add('GET', '/api/v1/admin/backup', (c) => t.admin.exportBackup(c.actor));

  const buckets = new Map<string, { tokens: number; at: number }>();
  const rate = opts.ratePerMinute ?? 600;
  const allow = (key: string) => {
    const now = t.clock().getTime();
    const b = buckets.get(key) ?? { tokens: rate, at: now };
    b.tokens = Math.min(rate, b.tokens + ((now - b.at) / 60_000) * rate);
    b.at = now;
    buckets.set(key, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };

  return async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const correlationId = sanitizeId(req.headers.get('x-correlation-id')) ?? `req_${t.newId()}`;
    const headers = { 'x-correlation-id': correlationId };
    try {
      if (url.pathname === '/healthz') return json({ ok: true, service: 'auto-tower' }, 200, headers);
      const wh = url.pathname.match(/^\/webhooks\/([a-z0-9-]+)\/([A-Za-z0-9_]+)$/);
      if (wh && req.method === 'POST') {
        const raw = await readBody(req);
        return json(await t.issues.handleWebhook(wh[2]!, wh[1]!, req.headers, raw), 200, headers);
      }
      if (url.pathname === '/mcp') {
        const actor = await t.authenticate(bearer(req), correlationId);
        if (!allow(actor.principal.id)) throw new TowerError('rate_limited', 'too many requests');
        return await handleMcp(t, actor, req, headers);
      }
      if (!url.pathname.startsWith('/api/')) return json({ error: { code: 'not_found', message: 'not found' } }, 404, headers);
      const route = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
      if (!route) return json({ error: { code: 'not_found', message: `no route ${req.method} ${url.pathname}` } }, 404, headers);
      const actor = await t.authenticate(bearer(req), correlationId);
      if (!allow(actor.principal.id)) throw new TowerError('rate_limited', 'too many requests; back off and retry');
      const m = url.pathname.match(route.re)!;
      const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)]));
      let cached: unknown;
      const body = async () => {
        if (cached === undefined) {
          const raw = await readBody(req);
          cached = raw ? JSON.parse(raw) : {};
        }
        return cached;
      };
      const result = await route.handler({ req, params, url, actor, body, idem: sanitizeId(req.headers.get('idempotency-key')) });
      return json(result ?? { ok: true }, 200, headers);
    } catch (err) {
      return errorResponse(err, headers);
    }
  };
}

function requireWrite(actor: Actor) {
  if (!actor.principal.scopes.includes('missions:write')) throw new TowerError('forbidden', 'missing scope missions:write');
}

export function errorResponse(err: unknown, headers: Record<string, string>): Response {
  if (err instanceof TowerError) {
    const extra: Record<string, string> = err.code === 'unavailable' ? { 'retry-after': '30' } : err.code === 'rate_limited' ? { 'retry-after': '10' } : {};
    return json(err.toJSON(), err.status, { ...headers, ...extra });
  }
  if (err instanceof ZodError) return json({ error: { code: 'invalid', message: 'invalid request', details: { issues: err.issues.slice(0, 20) } } }, 400, headers);
  if (err instanceof SyntaxError) return json({ error: { code: 'invalid', message: 'body must be JSON' } }, 400, headers);
  console.error('auto-tower internal error', err);
  return json({ error: { code: 'internal', message: 'internal error' } }, 500, headers);
}

async function readBody(req: Request): Promise<string> {
  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > MAX_BODY) throw new TowerError('invalid', 'request body too large');
  const text = await req.text();
  if (text.length > MAX_BODY) throw new TowerError('invalid', 'request body too large');
  return text;
}

function bearer(req: Request): string | null {
  const h = req.headers.get('authorization');
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

function sanitizeId(v: string | null): string | undefined {
  return v && /^[A-Za-z0-9_.:-]{1,100}$/.test(v) ? v : undefined;
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
}

/** Drop undefined keys so zod output satisfies exactOptional-style service inputs. */
export function stripUndefined<T extends object>(o: T): T {
  return JSON.parse(JSON.stringify(o)) as T;
}
