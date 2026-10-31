import { describe, expect, it } from 'vitest';
import {
  createPrincipal,
  ensureWorkspace,
  type PrincipalKind,
  SCOPES,
  SCOPES_BY_KIND,
  type Scope,
} from '../../src/auth/principals.js';
import {
  authenticateToken,
  hashToken,
  issueToken,
  revokeToken,
} from '../../src/auth/tokens.js';
import {
  openTestDatabase,
  seedPrincipal,
  TEST_WORKSPACE,
} from '../helpers/tower.js';

describe('revocation', () => {
  it('revokes only the named token', () => {
    const db = openTestDatabase();
    const owner = seedPrincipal(db, { kind: 'human' });
    const sibling = issueToken(db, { principalId: owner.principalId });
    const other = seedPrincipal(db, { kind: 'human', name: 'other' });

    revokeToken(db, owner.tokenId);

    expect(authenticateToken(db, owner.token)).toBeUndefined();
    expect(authenticateToken(db, sibling.token)).toBeDefined();
    expect(authenticateToken(db, other.token)).toBeDefined();
  });

  it('keeps the first revocation time', () => {
    const db = openTestDatabase();
    const seeded = seedPrincipal(db, { kind: 'human' });

    revokeToken(db, seeded.tokenId, new Date('2026-10-01T00:00:00Z'));
    revokeToken(db, seeded.tokenId, new Date('2026-10-02T00:00:00Z'));

    expect(
      db.get<{ revoked_at: string }>(
        'SELECT revoked_at FROM api_tokens WHERE id = ?',
        [seeded.tokenId],
      )?.revoked_at,
    ).toBe('2026-10-01T00:00:00.000Z');
  });

  it('ignores an unknown token id', () => {
    const db = openTestDatabase();

    expect(() => revokeToken(db, 'tok_missing')).not.toThrow();
  });
});

describe('scope ceilings', () => {
  it('pins the ceiling table for every kind', () => {
    expect(SCOPES_BY_KIND).toEqual({
      human: SCOPES,
      chief_of_staff: [
        'mission:read',
        'mission:write',
        'decision:read',
        'decision:write',
        'policy:read',
      ],
      runner: ['mission:read', 'runner:read', 'runner:write'],
      provider_adapter: ['mission:read', 'provider:sync'],
    });
  });

  const restricted: PrincipalKind[] = [
    'chief_of_staff',
    'runner',
    'provider_adapter',
  ];
  for (const kind of restricted) {
    const outside = SCOPES.filter(
      (scope) => !SCOPES_BY_KIND[kind].includes(scope),
    );
    it.each(outside)(
      'refuses %s for a %s token and writes nothing',
      (scope: Scope) => {
        const db = openTestDatabase();
        ensureWorkspace(db, TEST_WORKSPACE, TEST_WORKSPACE);
        const principal = createPrincipal(db, {
          workspaceId: TEST_WORKSPACE,
          kind,
          name: kind,
        });

        expect(() =>
          issueToken(db, { principalId: principal.id, scopes: [scope] }),
        ).toThrow(/not allowed/);
        expect(
          db.get<{ n: number }>('SELECT COUNT(*) AS n FROM api_tokens')?.n,
        ).toBe(0);
      },
    );
  }

  it('drops stored scopes above the kind ceiling at authentication time', () => {
    const db = openTestDatabase();
    const runner = seedPrincipal(db, { kind: 'runner' });
    db.run('UPDATE api_tokens SET scopes_json = ? WHERE id = ?', [
      JSON.stringify([
        'runner:read',
        'policy:write',
        'admin:tokens',
        'nonsense',
      ]),
      runner.tokenId,
    ]);

    expect(authenticateToken(db, runner.token)?.scopes).toEqual([
      'runner:read',
    ]);
  });

  it('refuses to issue a token for a disabled principal', () => {
    const db = openTestDatabase();
    ensureWorkspace(db, TEST_WORKSPACE, TEST_WORKSPACE);
    const principal = createPrincipal(db, {
      workspaceId: TEST_WORKSPACE,
      kind: 'runner',
      name: 'r',
    });
    db.run('UPDATE principals SET disabled_at = ? WHERE id = ?', [
      new Date().toISOString(),
      principal.id,
    ]);

    expect(() => issueToken(db, { principalId: principal.id })).toThrow(
      /disabled/,
    );
    expect(
      db.get<{ n: number }>('SELECT COUNT(*) AS n FROM api_tokens')?.n,
    ).toBe(0);
  });

  it('refuses an expiry that is not a valid date after issue time', () => {
    const db = openTestDatabase();
    const seeded = seedPrincipal(db, { kind: 'human' });

    expect(() =>
      issueToken(db, {
        principalId: seeded.principalId,
        expiresAt: new Date('invalid'),
      }),
    ).toThrow(/expiry/);
    expect(() =>
      issueToken(db, {
        principalId: seeded.principalId,
        expiresAt: new Date('2026-10-01T00:00:00Z'),
        now: new Date('2026-10-02T00:00:00Z'),
      }),
    ).toThrow(/expiry/);
  });
});

describe('stored token fields', () => {
  it('treats an unparseable expiry as expired rather than failing open', () => {
    const db = openTestDatabase();
    const seeded = seedPrincipal(db, { kind: 'human' });
    db.run("UPDATE api_tokens SET expires_at = 'never' WHERE id = ?", [
      seeded.tokenId,
    ]);

    expect(authenticateToken(db, seeded.token)).toBeUndefined();
  });

  it('stores the principal workspace on the token row', () => {
    const db = openTestDatabase();
    seedPrincipal(db, { kind: 'human', workspaceId: 'ws_other' });
    const runner = seedPrincipal(db, {
      kind: 'runner',
      workspaceId: 'ws_other',
      name: 'r',
    });

    expect(
      db.get<{ workspace_id: string }>(
        'SELECT workspace_id FROM api_tokens WHERE id = ?',
        [runner.tokenId],
      )?.workspace_id,
    ).toBe('ws_other');
  });

  it('keeps the raw token out of every table and stores its digest', () => {
    const db = openTestDatabase();
    const seeded = seedPrincipal(db, { kind: 'human' });
    const tables = db
      .all<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      )
      .map((row) => row.name);

    for (const table of tables) {
      expect(
        JSON.stringify(db.all(`SELECT * FROM ${table}`)),
        table,
      ).not.toContain(seeded.token);
    }
    expect(JSON.stringify(db.all('SELECT * FROM api_tokens'))).toContain(
      hashToken(seeded.token),
    );
  });
});
