import { describe, expect, it } from 'vitest';
import { createApp, type RouteSpec } from '../../src/api/app.js';
import { revokeToken } from '../../src/auth/tokens.js';
import { openTestDatabase, seedPrincipal } from '../helpers/tower.js';

const probe: RouteSpec = {
  method: 'get',
  path: '/probe',
  access: { scopes: ['mission:read', 'decision:read'] },
  handler: (c) => c.json({ principalId: c.get('auth').principal.id }),
};

function setup(now = new Date('2026-10-31T00:00:00Z')) {
  const db = openTestDatabase();
  const app = createApp({ db, now: () => now }, [probe]);
  return { db, app };
}

describe('authentication middleware', () => {
  it('answers 401 with a challenge when no credential is sent', async () => {
    const { app } = setup();

    const res = await app.request('/probe');

    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect(await res.json()).toEqual({
      error: {
        code: 'unauthenticated',
        message: 'A valid bearer token is required',
      },
    });
  });

  it('answers the same 401 body for malformed, unknown and revoked credentials', async () => {
    const { db, app } = setup();
    const revoked = seedPrincipal(db, { kind: 'human' });
    revokeToken(db, revoked.tokenId);

    const bodies = await Promise.all(
      [
        { authorization: 'Basic dXNlcjpwYXNz' },
        {
          authorization:
            'Bearer twr_unknownunknownunknownunknownunknownunknown',
        },
        { authorization: `Bearer ${revoked.token}` },
      ].map(async (headers) => {
        const res = await app.request('/probe', { headers });
        expect(res.status).toBe(401);
        return res.text();
      }),
    );

    expect(new Set(bodies).size).toBe(1);
  });

  it('answers 401 for an expired token', async () => {
    const { db, app } = setup(new Date('2026-10-31T00:00:00Z'));
    const seeded = seedPrincipal(db, {
      kind: 'human',
      expiresAt: new Date('2026-10-30T00:00:00Z'),
      now: new Date('2026-10-29T00:00:00Z'),
    });

    const res = await app.request('/probe', {
      headers: { authorization: `Bearer ${seeded.token}` },
    });

    expect(res.status).toBe(401);
  });

  it('answers 403 when the token lacks any required scope', async () => {
    const { db, app } = setup();
    const runner = seedPrincipal(db, { kind: 'runner' });
    const partial = seedPrincipal(db, {
      kind: 'human',
      scopes: ['mission:read'],
    });

    const runnerRes = await app.request('/probe', {
      headers: { authorization: `Bearer ${runner.token}` },
    });
    const partialRes = await app.request('/probe', {
      headers: { authorization: `Bearer ${partial.token}` },
    });

    expect(runnerRes.status).toBe(403);
    expect(partialRes.status).toBe(403);
    expect(await partialRes.json()).toEqual({
      error: {
        code: 'forbidden',
        message: 'The token lacks a scope this route requires',
      },
    });
  });

  it('lets a token holding every required scope through and exposes the principal', async () => {
    const { db, app } = setup();
    const human = seedPrincipal(db, { kind: 'human' });

    const res = await app.request('/probe', {
      headers: { authorization: `Bearer ${human.token}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ principalId: human.principalId });
  });
});

describe('expiry against the request clock', () => {
  it('rejects a token once the app clock passes its expiry, and accepts it before', async () => {
    const db = openTestDatabase();
    const seeded = seedPrincipal(db, {
      kind: 'human',
      expiresAt: new Date('2030-01-01T00:00:00Z'),
    });
    const headers = { authorization: `Bearer ${seeded.token}` };

    const before = createApp(
      { db, now: () => new Date('2029-06-01T00:00:00Z') },
      [probe],
    );
    const after = createApp(
      { db, now: () => new Date('2031-01-01T00:00:00Z') },
      [probe],
    );

    expect((await before.request('/probe', { headers })).status).toBe(200);
    expect((await after.request('/probe', { headers })).status).toBe(401);
  });
});

describe('indistinguishable credential failures', () => {
  it('returns the same status, body and challenge header for every failure mode', async () => {
    const db = openTestDatabase();
    const now = () => new Date('2026-10-31T00:00:00Z');
    const app = createApp({ db, now }, [probe]);

    const revoked = seedPrincipal(db, { kind: 'human', name: 'revoked' });
    revokeToken(db, revoked.tokenId);
    const expired = seedPrincipal(db, {
      kind: 'human',
      name: 'expired',
      expiresAt: new Date('2026-10-30T00:00:00Z'),
      now: new Date('2026-10-29T00:00:00Z'),
    });
    const disabled = seedPrincipal(db, { kind: 'runner', name: 'disabled' });
    db.run('UPDATE principals SET disabled_at = ? WHERE id = ?', [
      now().toISOString(),
      disabled.principalId,
    ]);

    const attempts: Array<Record<string, string>> = [
      {},
      { authorization: 'Basic dXNlcjpwYXNz' },
      {
        authorization: 'Bearer twr_unknownunknownunknownunknownunknownunknown',
      },
      { authorization: 'Bearer a b' },
      { authorization: `Bearer ${revoked.token}` },
      { authorization: `Bearer ${expired.token}` },
      { authorization: `Bearer ${disabled.token}` },
    ];
    const fingerprints = new Set<string>();
    for (const headers of attempts) {
      const res = await app.request('/probe', { headers });
      fingerprints.add(
        JSON.stringify([
          res.status,
          res.headers.get('www-authenticate'),
          await res.text(),
        ]),
      );
    }

    expect(fingerprints.size).toBe(1);
    expect([...fingerprints][0]).toContain('401');
  });
});

describe('bearer scheme', () => {
  it('accepts the scheme case-insensitively', async () => {
    const db = openTestDatabase();
    const human = seedPrincipal(db, { kind: 'human' });
    const app = createApp({ db }, [probe]);

    const res = await app.request('/probe', {
      headers: { authorization: `bearer ${human.token}` },
    });

    expect(res.status).toBe(200);
  });
});
