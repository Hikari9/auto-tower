import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/auth/cli.js';
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

describe('fail-closed token resolution', () => {
  it.each([
    ['a non-expiring token', undefined],
    ['a token with a future expiry', new Date('2099-01-01T00:00:00Z')],
  ])('rejects %s when the clock is invalid', (_label, expiresAt) => {
    const db = openTestDatabase();
    const seeded = seedPrincipal(db, {
      kind: 'human',
      ...(expiresAt ? { expiresAt } : {}),
    });

    expect(
      authenticateToken(db, seeded.token, new Date('invalid')),
    ).toBeUndefined();
  });

  it.each([
    ['malformed JSON', '['],
    ['a non-array value', '{"scope":"mission:read"}'],
    ['only scopes above the ceiling', '["policy:write"]'],
  ])('rejects a stored scope list that is %s', (_label, scopesJson) => {
    const db = openTestDatabase();
    const runner = seedPrincipal(db, { kind: 'runner' });
    db.run('UPDATE api_tokens SET scopes_json = ? WHERE id = ?', [
      scopesJson,
      runner.tokenId,
    ]);

    expect(authenticateToken(db, runner.token)).toBeUndefined();
  });
});

describe('owner CLI input handling (hardening)', () => {
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

  function tokenFrom(lines: string[]): string {
    return (lines.find((line) => line.startsWith('token: ')) ?? '').slice(
      'token: '.length,
    );
  }

  describe('owner CLI input handling', () => {
    it('treats an empty --db as unset and falls back to TOWER_DB_PATH', () => {
      const path = tempDbPath();
      const out = capture();

      expect(
        runCli(['token', 'create', '--kind', 'human', '--db', ''], out.io, {
          TOWER_DB_PATH: path,
        }),
      ).toBe(0);

      const db = openSqliteDatabase(path);
      expect(authenticateToken(db, tokenFrom(out.stdout))).toBeDefined();
      db.close();
    });

    it.each([
      [
        'a separator-only scope list',
        ['--scopes', ','],
        '--scopes contains an unknown scope',
      ],
      [
        'an unknown scope',
        ['--scopes', 'mission:read,nope'],
        '--scopes contains an unknown scope',
      ],
      [
        'an expiry that overflows Date',
        ['--expires-in-days', '1e9'],
        '--expires-in-days must be a positive number',
      ],
      [
        'a negative expiry',
        ['--expires-in-days=-1'],
        '--expires-in-days must be a positive number',
      ],
    ])('exits 2 with a specific message for %s', (_label, extra, message) => {
      const out = capture();

      expect(
        runCli(
          [
            'token',
            'create',
            '--kind',
            'human',
            ...extra,
            '--db',
            tempDbPath(),
          ],
          out.io,
          {},
        ),
      ).toBe(2);
      expect(out.stderr).toContain(message);
    });

    it('reports a clean error and writes nothing when the scopes exceed the kind ceiling', () => {
      const path = tempDbPath();
      const out = capture();

      expect(
        runCli(
          [
            'token',
            'create',
            '--kind',
            'runner',
            '--scopes',
            'policy:write',
            '--db',
            path,
          ],
          out.io,
          {},
        ),
      ).toBe(2);

      expect(out.stderr.join('\n')).toMatch(
        /Token not issued: .*not allowed for runner/,
      );
      const db = openSqliteDatabase(path);
      expect(
        db.get<{ n: number }>('SELECT COUNT(*) AS n FROM principals')?.n,
      ).toBe(0);
      expect(
        db.get<{ n: number }>('SELECT COUNT(*) AS n FROM workspaces')?.n,
      ).toBe(0);
      db.close();
    });

    it('prints the raw token once on stdout only, and stores only its digest', () => {
      const path = tempDbPath();
      const out = capture();
      runCli(['token', 'create', '--kind', 'human', '--db', path], out.io, {});
      const token = tokenFrom(out.stdout);

      expect(out.stdout.filter((line) => line.includes(token))).toHaveLength(1);
      expect(out.stderr.join('\n')).not.toContain(token);
      expect(out.stderr).toContain(
        'Store the token now. It is stored only as a hash and cannot be shown again.',
      );
      // Positive control: the file holds the digest, so the absence check above is meaningful.
      expect(readFileSync(path).toString('latin1')).toContain(hashToken(token));
      expect(readFileSync(path).toString('latin1')).not.toContain(token);
    });
  });

  describe('owner CLI empty-value fallbacks', () => {
    it('uses the default workspace when --workspace is empty', () => {
      const path = tempDbPath();
      const out = capture();

      expect(
        runCli(
          [
            'token',
            'create',
            '--kind',
            'human',
            '--workspace',
            '',
            '--db',
            path,
          ],
          out.io,
          {},
        ),
      ).toBe(0);

      const db = openSqliteDatabase(path);
      expect(db.get<{ id: string }>('SELECT id FROM workspaces')?.id).toBe(
        'default',
      );
      db.close();
    });

    it('names the principal after its kind when --name is empty', () => {
      const path = tempDbPath();
      const out = capture();

      expect(
        runCli(
          ['token', 'create', '--kind', 'runner', '--name', '', '--db', path],
          out.io,
          {},
        ),
      ).toBe(0);

      const db = openSqliteDatabase(path);
      expect(
        db.get<{ name: string }>('SELECT name FROM principals')?.name,
      ).toBe('runner');
      db.close();
    });

    it('falls through to the default path when TOWER_DB_PATH is empty and no --db is given', () => {
      const out = capture();
      const cwd = process.cwd();
      const scratch = tempDbPath();
      process.chdir(dirname(scratch));
      try {
        expect(
          runCli(['token', 'create', '--kind', 'human'], out.io, {
            TOWER_DB_PATH: '',
          }),
        ).toBe(0);
        expect(
          existsSync(join(dirname(scratch), '.tower', 'tower.sqlite')),
        ).toBe(true);
      } finally {
        process.chdir(cwd);
      }
    });
  });
});
