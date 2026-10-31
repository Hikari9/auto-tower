import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/auth/cli.js';
import {
  createPrincipal,
  ensureWorkspace,
  SCOPES,
  SCOPES_BY_KIND,
} from '../../src/auth/principals.js';
import {
  authenticateToken,
  generateToken,
  hashToken,
  issueToken,
  revokeToken,
} from '../../src/auth/tokens.js';
import { openSqliteDatabase } from '../../src/storage/sqlite.js';
import {
  openTestDatabase,
  seedPrincipal,
  TEST_WORKSPACE,
  tempDbPath,
} from '../helpers/tower.js';

describe('token hashing', () => {
  it('generates prefixed, unique, high-entropy tokens', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).toMatch(/^twr_[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });

  it('hashes deterministically to a 64-character hex digest', () => {
    expect(hashToken('twr_example')).toBe(hashToken('twr_example'));
    expect(hashToken('twr_example')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('token storage and lifecycle', () => {
  it('never stores the raw token', () => {
    const db = openTestDatabase();
    const { token } = seedPrincipal(db, { kind: 'human' });
    const rows = JSON.stringify(db.all('SELECT * FROM api_tokens'));
    expect(rows).not.toContain(token);
    expect(rows).toContain(hashToken(token));
  });

  it('authenticates a valid token to its principal and scopes', () => {
    const db = openTestDatabase();
    const seeded = seedPrincipal(db, { kind: 'runner', name: 'laptop-1' });

    const auth = authenticateToken(db, seeded.token);

    expect(auth?.principal).toMatchObject({
      id: seeded.principalId,
      kind: 'runner',
      name: 'laptop-1',
      workspaceId: TEST_WORKSPACE,
    });
    expect(auth?.scopes).toEqual(SCOPES_BY_KIND.runner);
  });

  it('rejects unknown, malformed, and revoked tokens', () => {
    const db = openTestDatabase();
    const seeded = seedPrincipal(db, { kind: 'human' });

    expect(authenticateToken(db, 'not-a-token')).toBeUndefined();
    expect(authenticateToken(db, generateToken())).toBeUndefined();

    revokeToken(db, seeded.tokenId);
    expect(authenticateToken(db, seeded.token)).toBeUndefined();
  });

  it('honours expiry at the boundary', () => {
    const db = openTestDatabase();
    const issuedAt = new Date('2026-10-01T00:00:00Z');
    const expiresAt = new Date('2026-10-02T00:00:00Z');
    const seeded = seedPrincipal(db, {
      kind: 'human',
      expiresAt,
      now: issuedAt,
    });

    expect(
      authenticateToken(db, seeded.token, new Date('2026-10-01T23:59:59Z')),
    ).toBeDefined();
    expect(authenticateToken(db, seeded.token, expiresAt)).toBeUndefined();
  });

  it('rejects tokens whose principal has been disabled', () => {
    const db = openTestDatabase();
    const seeded = seedPrincipal(db, { kind: 'provider_adapter' });

    db.run('UPDATE principals SET disabled_at = ? WHERE id = ?', [
      new Date().toISOString(),
      seeded.principalId,
    ]);

    expect(authenticateToken(db, seeded.token)).toBeUndefined();
  });
});

describe('scope ceilings per principal kind', () => {
  it('lets only a human hold policy and token administration scopes', () => {
    expect(SCOPES_BY_KIND.human).toEqual(SCOPES);
    for (const kind of [
      'chief_of_staff',
      'runner',
      'provider_adapter',
    ] as const) {
      expect(SCOPES_BY_KIND[kind]).not.toContain('policy:write');
      expect(SCOPES_BY_KIND[kind]).not.toContain('admin:tokens');
    }
  });

  it('refuses to issue a token above its principal kind ceiling', () => {
    const db = openTestDatabase();
    ensureWorkspace(db, TEST_WORKSPACE, TEST_WORKSPACE);
    const runner = createPrincipal(db, {
      workspaceId: TEST_WORKSPACE,
      kind: 'runner',
      name: 'r',
    });

    expect(() =>
      issueToken(db, { principalId: runner.id, scopes: ['policy:write'] }),
    ).toThrow(/not allowed for runner/);
  });

  it('refuses an empty scope list', () => {
    const db = openTestDatabase();
    const { principalId } = seedPrincipal(db, { kind: 'runner' });

    expect(() => issueToken(db, { principalId, scopes: [] })).toThrow(
      /at least one scope/,
    );
  });

  it('narrows a token to a subset of its kind ceiling', () => {
    const db = openTestDatabase();
    const { principalId } = seedPrincipal(db, { kind: 'human' });

    const narrow = issueToken(db, {
      principalId,
      scopes: ['mission:read', 'mission:read'],
    });

    expect(narrow.scopes).toEqual(['mission:read']);
  });
});

describe('owner bootstrap CLI', () => {
  function capture() {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return {
      io: {
        stdout: (line: string) => stdout.push(line),
        stderr: (line: string) => stderr.push(line),
      },
      stdout,
      stderr,
    };
  }

  it('creates an owner token that authenticates against the database file', () => {
    const path = tempDbPath();
    const out = capture();

    const code = runCli(
      [
        'token',
        'create',
        '--kind',
        'human',
        '--workspace',
        'ws_owner',
        '--db',
        path,
      ],
      out.io,
      {},
      new Date('2026-10-31T00:00:00Z'),
    );

    expect(code).toBe(0);
    const token = out.stdout
      .find((line) => line.startsWith('token: '))
      ?.slice('token: '.length);
    expect(token).toBeDefined();
    const db = openSqliteDatabase(path);
    const auth = authenticateToken(db, token ?? '');
    expect(auth?.principal).toMatchObject({
      kind: 'human',
      workspaceId: 'ws_owner',
    });
    expect(auth?.scopes).toEqual(SCOPES);
    db.close();
  });

  it('creates the database directory on a fresh checkout', () => {
    const path = join(
      tempDbPath().replace(/tower\.sqlite$/, ''),
      'fresh',
      'tower.sqlite',
    );
    const out = capture();

    expect(
      runCli(['token', 'create', '--kind', 'human', '--db', path], out.io, {}),
    ).toBe(0);
  });

  it('keeps the raw token out of the database file', () => {
    const path = tempDbPath();
    const out = capture();
    runCli(['token', 'create', '--kind', 'human', '--db', path], out.io, {});
    const token = out.stdout.find((line) => line.startsWith('token: ')) ?? '';

    const bytes = readFileSync(path).toString('latin1');
    expect(bytes).not.toContain(token.slice('token: '.length));
  });

  it('rejects an unknown kind, an unknown scope, and an unknown command', () => {
    const path = tempDbPath();
    expect(
      runCli(
        ['token', 'create', '--kind', 'root', '--db', path],
        capture().io,
        {},
      ),
    ).toBe(2);
    expect(
      runCli(
        [
          'token',
          'create',
          '--kind',
          'human',
          '--scopes',
          'mission:read,nope',
          '--db',
          path,
        ],
        capture().io,
        {},
      ),
    ).toBe(2);
    expect(runCli(['token', 'revoke'], capture().io, {})).toBe(2);
  });

  it('honours --expires-in-days', () => {
    const path = tempDbPath();
    const out = capture();
    const now = new Date('2026-10-31T00:00:00Z');

    runCli(
      [
        'token',
        'create',
        '--kind',
        'human',
        '--expires-in-days',
        '7',
        '--db',
        path,
      ],
      out.io,
      {},
      now,
    );

    expect(out.stdout).toContain('expires: 2026-11-07T00:00:00.000Z');
  });
});
