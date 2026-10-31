import { describe, expect, it } from 'vitest';
import { createApp, ROUTES, type RouteSpec } from '../../src/api/app.js';
import { VersionConflictError } from '../../src/events/errors.js';
import { openTestDatabase, seedPrincipal } from '../helpers/tower.js';

describe('route declarations', () => {
  it('gives every shipped route either public access or at least one scope', () => {
    for (const route of ROUTES) {
      const isPublic = 'public' in route.access && route.access.public === true;
      const hasScopes =
        'scopes' in route.access && route.access.scopes.length > 0;
      expect(isPublic || hasScopes, `${route.method} ${route.path}`).toBe(true);
    }
  });

  it('refuses to mount a route that declares no access', () => {
    const db = openTestDatabase();
    const undeclared = {
      method: 'get',
      path: '/open',
      access: { scopes: [] },
      handler: (c: { json: (body: unknown) => Response }) => c.json({}),
    } as unknown as RouteSpec;

    expect(() => createApp({ db }, [undeclared])).toThrow(/declares no access/);
  });

  it('requires a credential on every non-public route', async () => {
    const db = openTestDatabase();
    const scoped: RouteSpec[] = [
      {
        method: 'get',
        path: '/a',
        access: { scopes: ['mission:read'] },
        handler: (c) => c.json({}),
      },
      {
        method: 'post',
        path: '/b',
        access: { scopes: ['mission:write'] },
        handler: (c) => c.json({}),
      },
    ];
    const app = createApp({ db }, [...ROUTES, ...scoped]);

    for (const [method, path] of [
      ['GET', '/a'],
      ['POST', '/b'],
    ] as const) {
      const res = await app.request(path, { method });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
    expect((await app.request('/health')).status).toBe(200);
  });
});

describe('error handling', () => {
  it('answers 404 with a JSON body for unknown routes', async () => {
    const app = createApp({ db: openTestDatabase() });

    const res = await app.request('/nope');

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: { code: 'not_found', message: 'Route not found' },
    });
  });

  it('answers 500 without leaking the internal error message', async () => {
    const db = openTestDatabase();
    const human = seedPrincipal(db, { kind: 'human' });
    const app = createApp({ db }, [
      {
        method: 'get',
        path: '/boom',
        access: { scopes: ['mission:read'] },
        handler: () => {
          throw new Error('table secrets_xyz leaked');
        },
      },
    ]);

    const res = await app.request('/boom', {
      headers: { authorization: `Bearer ${human.token}` },
    });
    const body = await res.text();

    expect(res.status).toBe(500);
    expect(body).toBe(
      '{"error":{"code":"internal_error","message":"Internal server error"}}',
    );
    expect(body).not.toContain('secrets_xyz');
  });

  it('maps a stale-version append to 409 version_conflict', async () => {
    const db = openTestDatabase();
    const human = seedPrincipal(db, { kind: 'human' });
    const app = createApp({ db }, [
      {
        method: 'post',
        path: '/write',
        access: { scopes: ['mission:write'] },
        handler: () => {
          throw new VersionConflictError('mission:m1', 0, 1);
        },
      },
    ]);

    const res = await app.request('/write', {
      method: 'POST',
      headers: { authorization: `Bearer ${human.token}` },
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: {
        code: 'version_conflict',
        message: 'Stream mission:m1 is at version 1, expected 0',
      },
    });
  });
});
