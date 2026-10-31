import { describe, expect, it } from 'vitest';
import { createApp, type RouteSpec } from '../../src/api/app.js';
import { revokeToken } from '../../src/auth/tokens.js';
import { openTestDatabase, seedPrincipal } from '../helpers/tower.js';

const probe: RouteSpec = {
  method: 'get',
  path: '/probe',
  access: { scopes: ['mission:read'] },
  handler: (c) => c.json({ principalId: c.get('auth').principal.id }),
};

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
