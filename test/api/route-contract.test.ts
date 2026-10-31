import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, ROUTES, type RouteSpec } from '../../src/api/app.js';
import { IdempotencyKeyReuseError } from '../../src/events/errors.js';
import { openTestDatabase, seedPrincipal } from '../helpers/tower.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('public surface', () => {
  it('exposes exactly one public route, /health', () => {
    const publicPaths = ROUTES.filter(
      (r) => 'public' in r.access && r.access.public === true,
    ).map((r) => r.path);

    expect(publicPaths).toEqual(['/health']);
  });

  it('refuses a route whose access is not explicitly public', () => {
    const route = {
      method: 'get',
      path: '/open',
      access: { public: false },
      handler: (c: { json: (body: unknown) => Response }) => c.json({}),
    } as unknown as RouteSpec;

    expect(() => createApp({ db: openTestDatabase() }, [route])).toThrow(
      /declares no access/,
    );
  });
});

describe('error mapping', () => {
  it('maps an idempotency key reused with a different body to 409 with its code', async () => {
    const db = openTestDatabase();
    const human = seedPrincipal(db, { kind: 'human' });
    const app = createApp({ db }, [
      {
        method: 'post',
        path: '/write',
        access: { scopes: ['mission:write'] },
        handler: () => {
          throw new IdempotencyKeyReuseError('k1');
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
        code: 'idempotency_key_reused',
        message: 'Idempotency key k1 was already used for a different request',
      },
    });
  });

  it('logs only the error name for an unhandled error', async () => {
    const db = openTestDatabase();
    const human = seedPrincipal(db, { kind: 'human' });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = createApp({ db }, [
      {
        method: 'get',
        path: '/boom',
        access: { scopes: ['mission:read'] },
        handler: () => {
          throw new Error('secrets_xyz in the message');
        },
      },
    ]);

    await app.request('/boom', {
      headers: { authorization: `Bearer ${human.token}` },
    });

    expect(spy.mock.calls).toEqual([['unhandled error', 'Error']]);
  });
});
