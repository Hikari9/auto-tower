import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from 'hono';
import type { AppEnv, RouteSpec } from '../app.js';
import { errorBody } from '../errors.js';

/**
 * Files the dashboard serves from `public/`, keyed by their path under /dashboard.
 * Only these are ever read, so a request path cannot reach anything else on disk.
 * A Map, not an object, so names such as `constructor` never match an inherited key.
 * The dashboard holds no secrets: every data call goes through the API with the caller's own token.
 */
export const DASHBOARD_ASSETS: ReadonlyMap<string, string> = new Map([
  ['', 'text/html; charset=utf-8'],
  ['index.html', 'text/html; charset=utf-8'],
  ['styles.css', 'text/css; charset=utf-8'],
  ['persona.json', 'application/json; charset=utf-8'],
  ['js/app.js', 'text/javascript; charset=utf-8'],
  ['js/api.js', 'text/javascript; charset=utf-8'],
  ['js/boot.js', 'text/javascript; charset=utf-8'],
  ['js/dom.js', 'text/javascript; charset=utf-8'],
  ['js/status.js', 'text/javascript; charset=utf-8'],
  ['js/views.js', 'text/javascript; charset=utf-8'],
]);

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const cache = new Map<string, string>();

function readAsset(name: string): string {
  const cached = cache.get(name);
  if (cached !== undefined) {
    return cached;
  }
  // Resolved on first read, not at import: `import.meta.dirname` is absent in some hosts,
  // and a module-level read would fail the whole import rather than only this route.
  const publicDir = join(import.meta.dirname, '../../../public');
  const text = readFileSync(join(publicDir, name), 'utf8');
  cache.set(name, text);
  return text;
}

function serve(name: string) {
  return (c: Context<AppEnv>) => {
    const type = DASHBOARD_ASSETS.get(name);
    if (type === undefined) {
      return c.json(errorBody('not_found', 'Route not found'), 404);
    }
    return new Response(readAsset(name === '' ? 'index.html' : name), {
      headers: {
        'content-type': type,
        'content-security-policy': CSP,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cache-control': 'no-cache',
      },
    });
  };
}

/** `/dashboard` and `/dashboard/` answer the shell. Everything else is looked up in `DASHBOARD_ASSETS`. */
const shell: RouteSpec = {
  method: 'get',
  path: '/dashboard',
  access: { public: true },
  handler: serve(''),
};

const asset: RouteSpec = {
  method: 'get',
  path: '/dashboard/*',
  access: { public: true },
  handler: (c) => {
    const name = c.req.path.slice('/dashboard/'.length);
    return serve(name)(c);
  },
};

/** Public routes for the dashboard shell and its static files. Mount them with the API routes. */
export const dashboardRoutes: readonly RouteSpec[] = [shell, asset];
