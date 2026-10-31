import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../src/auth/cli.js';
import { authenticateToken, hashToken } from '../../src/auth/tokens.js';
import { openSqliteDatabase } from '../../src/storage/sqlite.js';
import { tempDbPath } from '../helpers/tower.js';

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
        ['token', 'create', '--kind', 'human', ...extra, '--db', tempDbPath()],
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
        ['token', 'create', '--kind', 'human', '--workspace', '', '--db', path],
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
    expect(db.get<{ name: string }>('SELECT name FROM principals')?.name).toBe(
      'runner',
    );
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
      expect(existsSync(join(dirname(scratch), '.tower', 'tower.sqlite'))).toBe(
        true,
      );
    } finally {
      process.chdir(cwd);
    }
  });
});
