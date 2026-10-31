import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp, ROUTES } from '../../src/api/app.js';
import {
  DASHBOARD_ASSETS,
  dashboardRoutes,
} from '../../src/api/routes/dashboard.js';
import worker, {
  WORKER_DASHBOARD_CSP,
  WORKER_DASHBOARD_FILES,
  type WorkerEnv,
} from '../../src/hosting/worker.js';
import { openTestDatabase } from '../helpers/tower.js';

/** The policy both hosts must send. Written out so a drift in either copy fails here. */
const EXPECTED_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const PUBLIC_DIR = join(import.meta.dirname, '../../public');

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
};

/** Stands in for the Workers static-assets binding: serves files from public/ and 404s the rest. */
function assetsBinding(): NonNullable<WorkerEnv['ASSETS']> {
  return {
    fetch(request: Request) {
      const { pathname } = new URL(request.url);
      // Workers static assets redirect /index.html to "/" (html_handling auto-trailing-slash).
      if (pathname === '/index.html') {
        return new Response(null, { status: 307, headers: { location: '/' } });
      }
      const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
      try {
        const body = readFileSync(join(PUBLIC_DIR, rel), 'utf8');
        return new Response(body, {
          headers: {
            'content-type':
              TYPES[rel.split('.').pop() ?? ''] ?? 'application/octet-stream',
          },
        });
      } catch {
        return new Response('not found', { status: 404 });
      }
    },
  };
}

const origin = 'https://tower.example';

describe('Workers entry serves the dashboard', () => {
  it('serves the shell from the assets binding with the shared policy', async () => {
    const res = await worker.fetch(new Request(`${origin}/dashboard`), {
      ASSETS: assetsBinding(),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('content-security-policy')).toBe(EXPECTED_CSP);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toContain('id="app"');
  });

  it('serves each dashboard file under /dashboard/ with its own type', async () => {
    const env = { ASSETS: assetsBinding() };

    const script = await worker.fetch(
      new Request(`${origin}/dashboard/js/app.js`),
      env,
    );
    const persona = await worker.fetch(
      new Request(`${origin}/dashboard/persona.json`),
      env,
    );

    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toContain('text/javascript');
    expect(persona.headers.get('content-type')).toContain('application/json');
    for (const res of [script, persona]) {
      expect(res.headers.get('content-security-policy')).toBe(EXPECTED_CSP);
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    }
  });

  it('refuses paths outside its file list, even when the binding has them', async () => {
    const binding = assetsBinding();
    const env = { ASSETS: binding };

    for (const path of [
      '/dashboard/secret.txt',
      '/dashboard/js%2f..%2f..%2fpackage.json',
      '/dashboard/constructor',
      '/dashboard/js/app.d.ts',
      '/dashboard/js/boot.d.ts',
    ]) {
      if (path.endsWith('.d.ts')) {
        // The binding serves these, so the 404 below can only come from the allowlist.
        const direct = await binding.fetch(
          new Request(`${origin}${path.replace('/dashboard', '')}`),
        );
        expect(direct.status, `binding serves ${path}`).toBe(200);
      }
      expect(
        (await worker.fetch(new Request(`${origin}${path}`), env)).status,
        path,
      ).toBe(404);
    }
  });

  it('answers 503 for the dashboard when no assets binding is configured', async () => {
    const res = await worker.fetch(new Request(`${origin}/dashboard`));

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      error: {
        code: 'not_configured',
        message: 'Dashboard assets are not bound',
      },
    });
  });

  it('keeps every other path closed with the storage 503', async () => {
    const env = { ASSETS: assetsBinding() };

    expect(
      (await worker.fetch(new Request(`${origin}/missions`), env)).status,
    ).toBe(503);
    expect(
      (
        await worker.fetch(
          new Request(`${origin}/dashboard`, { method: 'POST' }),
          env,
        )
      ).status,
    ).toBe(503);
  });

  it('keeps the Workers file list in step with the Node route', () => {
    const nodeFiles = [...DASHBOARD_ASSETS.keys()]
      .filter((name) => name !== '')
      .sort();

    expect([...WORKER_DASHBOARD_FILES].sort()).toEqual(nodeFiles);
    expect(WORKER_DASHBOARD_CSP).toBe(EXPECTED_CSP);
  });
});

describe('Node route serves the same policy', () => {
  it('sends the shared content security policy from the mounted dashboard routes', async () => {
    const app = createApp({ db: openTestDatabase() }, [
      ...ROUTES,
      ...dashboardRoutes,
    ]);

    const res = await app.request('/dashboard/js/views.js');

    expect(res.headers.get('content-security-policy')).toBe(EXPECTED_CSP);
    expect(res.headers.get('content-type')).toContain('text/javascript');
  });
});

describe('Workers deployment config', () => {
  it('binds the public directory as ASSETS, which the Workers entry reads', () => {
    const toml = readFileSync(
      join(import.meta.dirname, '../../wrangler.toml'),
      'utf8',
    );

    expect(toml).toMatch(
      /\[assets\]\s*\ndirectory = "public"\s*\nbinding = "ASSETS"/,
    );
  });
});

describe('Workers HEAD and encoded paths match the Node router', () => {
  it('answers HEAD with the shell headers and no body', async () => {
    const res = await worker.fetch(
      new Request(`${origin}/dashboard`, { method: 'HEAD' }),
      { ASSETS: assetsBinding() },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toBe(EXPECTED_CSP);
    expect(await res.text()).toBe('');
  });

  it('decodes an encoded file name the way the Node router does', async () => {
    const app = createApp({ db: openTestDatabase() }, [
      ...ROUTES,
      ...dashboardRoutes,
    ]);
    const path = '/dashboard/styles%2Ecss';

    expect((await app.request(path)).status).toBe(200);
    const res = await worker.fetch(new Request(`${origin}${path}`), {
      ASSETS: assetsBinding(),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/css');
  });
});

describe('Workers shell paths and config, round 3', () => {
  it('serves the shell for /dashboard/ and /dashboard/index.html', async () => {
    for (const path of ['/dashboard/', '/dashboard/index.html']) {
      const res = await worker.fetch(new Request(`${origin}${path}`), {
        ASSETS: assetsBinding(),
      });
      expect(res.status, path).toBe(200);
      expect(res.headers.get('content-type'), path).toContain('text/html');
    }
  });

  it('turns on run_worker_first so direct asset requests pass the Worker policy', () => {
    const toml = readFileSync(
      join(import.meta.dirname, '../../wrangler.toml'),
      'utf8',
    );

    expect(toml).toMatch(/run_worker_first = true/);
  });
});
