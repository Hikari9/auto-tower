import { describe, expect, it } from 'vitest';
import { createApp, ROUTES } from '../../src/api/app.js';
import { dashboardRoutes } from '../../src/api/routes/dashboard.js';
import { openTestDatabase, seedPrincipal } from '../helpers/tower.js';

function appWithDashboard() {
  const db = openTestDatabase();
  const human = seedPrincipal(db, { kind: 'human' });
  return {
    app: createApp({ db }, [...ROUTES, ...dashboardRoutes]),
    token: human.token,
  };
}

describe('dashboard shell', () => {
  it('serves the shell without a credential, under a strict content security policy', async () => {
    const { app } = appWithDashboard();

    const res = await app.request('/dashboard');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('content-security-policy')).toContain(
      "script-src 'self'",
    );
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const html = await res.text();
    expect(html).toContain(
      'name="viewport" content="width=device-width, initial-scale=1"',
    );
    expect(html).toContain(
      '<script type="module" src="/dashboard/js/boot.js">',
    );
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/);
  });

  it('answers /dashboard/ the same as /dashboard', async () => {
    const { app } = appWithDashboard();

    const res = await app.request('/dashboard/');

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('id="app"');
  });

  it('serves each whitelisted asset with its own content type', async () => {
    const { app } = appWithDashboard();

    const script = await app.request('/dashboard/js/views.js');
    const style = await app.request('/dashboard/styles.css');
    const persona = await app.request('/dashboard/persona.json');

    expect(script.headers.get('content-type')).toContain('text/javascript');
    expect(style.headers.get('content-type')).toContain('text/css');
    expect(persona.headers.get('content-type')).toContain('application/json');
    for (const res of [script, style, persona]) {
      expect(res.headers.get('content-security-policy')).toContain(
        "default-src 'self'",
      );
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    }
    expect(await persona.json()).toMatchObject({
      name: expect.any(String),
      tagline: expect.any(String),
    });
  });

  it('refuses any path outside the whitelist, including traversal attempts', async () => {
    const { app } = appWithDashboard();

    for (const path of [
      '/dashboard/secret.txt',
      '/dashboard/js/../../package.json',
      '/dashboard/%2e%2e/package.json',
      '/dashboard/js/missing.js',
      '/dashboard/..%2fpackage.json',
      '/dashboard/%2e%2e%2fpackage.json',
      '/dashboard/js%2f..%2f..%2fpackage.json',
      '/dashboard/js/app.d.ts',
    ]) {
      const res = await app.request(path);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).not.toContain('auto-tower');
    }
  });

  it('keeps the API closed: data routes still demand a token', async () => {
    const { app, token } = appWithDashboard();

    expect((await app.request('/missions')).status).toBe(401);
    expect(
      (
        await app.request('/missions', {
          headers: { authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(200);
  });

  it('declares a responsive, single-column layout that scrolls wide tables instead of overflowing', async () => {
    const { app } = appWithDashboard();
    const css = await (await app.request('/dashboard/styles.css')).text();

    expect(css).toContain('@media (min-width: 720px)');
    expect(css).toMatch(/\.table-wrap\s*\{[^}]*overflow-x:\s*auto/);
  });
});
