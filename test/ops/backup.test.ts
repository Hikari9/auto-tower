import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runOpsCli } from '../../src/ops/cli.js';
import {
  BackupError,
  exportBackup,
  readBackup,
  restoreBackup,
  storeFingerprint,
} from '../../src/ops/index.js';
import { applyMigrations } from '../../src/storage/migrate.js';
import {
  defaultMigrationsDir,
  readMigrationFiles,
} from '../../src/storage/migration-files.js';
import { openSqliteDatabase } from '../../src/storage/sqlite.js';
import { createWorld, tempDir } from '../e2e/world.js';
import { TEST_WORKSPACE } from '../helpers/tower.js';
import { ISSUE_URL } from '../issues/helpers.js';
import { key } from '../mcp/helpers.js';

const migrations = () => readMigrationFiles(defaultMigrationsDir());

/** A world with a mission, a link, two policy versions, a decision, and a runner enrolled. */
async function populated() {
  const world = createWorld();
  world.github.add(ISSUE_URL);
  const owner = await world.mcp(world.principals.owner.token);
  const cos = await world.mcp(world.principals.cos.token);
  const created = await owner.ok('create_mission', {
    title: 'Backed up',
    intent: 'i',
    outcome: 'o',
    risk: 'medium',
    links: [{ url: ISSUE_URL, classification: 'required', title: null }],
    idempotencyKey: key(),
  });
  const missionId = created.mission.id as string;
  const missions = world.core.missions;
  let state = missions.transitionMission(
    world.ownerCtx(),
    missionId,
    created.mission.version,
    'ready',
    null,
  ).mission;
  state = missions.addPacket(world.ownerCtx(), missionId, state.version, {
    title: 'p',
    instructions: 'do',
    scope: ['repo:a'],
    required: true,
    dependsOn: [],
  }).mission;
  await owner.ok('grant_policy', {
    action: 'work.execute',
    resource: 'repo:a',
    scope: 'repo:a',
    maxRisk: 'medium',
    grantee: { kind: 'chief_of_staff' },
    idempotencyKey: key(),
    confirm: true,
  });
  await cos.ok('request_expansion', {
    missionId,
    packetId: state.packets[0]?.id,
    action: 'repo.delete',
    resource: 'repo:a',
    scope: 'repo:a',
    risk: 'medium',
    question: 'May it?',
    confirm: true,
    idempotencyKey: key(),
  });
  await world.call(
    world.principals.owner.token,
    'POST',
    '/runners/enrollments',
    {
      name: 'r',
      version: '1.2.3',
      buildDigest: `sha256:${'a'.repeat(64)}`,
      allowedScopes: ['*'],
      maxConcurrent: 1,
    },
  );
  return { world, missionId };
}

describe('backup and restore drill', () => {
  it('restores missions, policy versions and audit history identically into a fresh store', async () => {
    const { world, missionId } = await populated();
    try {
      const before = storeFingerprint(world.db);
      const policyBefore = world.db.all('SELECT * FROM policy_state');
      const eventsBefore = world.db.all('SELECT * FROM events ORDER BY seq');
      const auditBefore = world.db.all('SELECT * FROM mcp_audit ORDER BY seq');
      expect(eventsBefore.length).toBeGreaterThan(3);
      expect(auditBefore.length).toBeGreaterThan(2);

      const backup = exportBackup(world.db);
      const dir = tempDir();
      const fresh = openSqliteDatabase(join(dir, 'fresh.sqlite'));
      const result = restoreBackup(
        fresh,
        readBackup(JSON.stringify(backup)),
        migrations(),
      );
      expect(result.migratedForward).toEqual([]);
      expect(result.rows).toBeGreaterThan(20);

      // Same state, table by table.
      const after = storeFingerprint(fresh);
      expect(after.digest).toBe(before.digest);
      expect(after.tables).toEqual(before.tables);
      expect(fresh.all('SELECT * FROM policy_state')).toEqual(policyBefore);
      expect(fresh.all('SELECT * FROM events ORDER BY seq')).toEqual(
        eventsBefore,
      );
      expect(fresh.all('SELECT * FROM mcp_audit ORDER BY seq')).toEqual(
        auditBefore,
      );
      expect(
        fresh.get('SELECT state FROM missions WHERE id = ?', [missionId]),
      ).toEqual(
        world.db.get('SELECT state FROM missions WHERE id = ?', [missionId]),
      );
      expect(
        fresh.get<{ n: number }>('SELECT COUNT(*) AS n FROM decisions')?.n ?? 0,
      ).toBe(1);
      expect(
        fresh.get<{ n: number }>('SELECT COUNT(*) AS n FROM runner_enrollments')
          ?.n ?? 0,
      ).toBe(1);
      fresh.close();
    } finally {
      world.close();
    }
  });

  it('is the same after a restart on the same file', async () => {
    const { world } = await populated();
    const before = storeFingerprint(world.db).digest;
    const path = world.dbPath;
    const principals = world.principals;
    world.close();
    const again = createWorld({
      dbPath: path,
      migrated: true,
      existing: { owner: principals.owner.id, cos: principals.cos.id },
    });
    try {
      expect(storeFingerprint(again.db).digest).toBe(before);
    } finally {
      again.close();
    }
  });

  it('keeps the append-only guarantees after a restore', async () => {
    const { world } = await populated();
    const fresh = openSqliteDatabase(join(tempDir(), 'x.sqlite'));
    restoreBackup(fresh, exportBackup(world.db), migrations());
    expect(() => fresh.run('UPDATE events SET type = type')).toThrow(
      /append-only/,
    );
    expect(() => fresh.run('DELETE FROM policy_receipts')).toThrow(
      /append-only/,
    );
    // A new event continues after the restored ones instead of colliding with them.
    const last = fresh.get<{ seq: number }>(
      'SELECT MAX(seq) AS seq FROM events',
    );
    expect(last?.seq).toBeGreaterThan(0);
    fresh.close();
    world.close();
  });

  it('leaves token digests out unless asked, so the file cannot sign anyone in', async () => {
    const { world } = await populated();
    const plain = exportBackup(world.db);
    expect(plain.tables.api_tokens).toBeUndefined();
    expect(JSON.stringify(plain)).not.toContain(world.principals.owner.token);
    const withTokens = exportBackup(world.db, { includeTokenDigests: true });
    expect(withTokens.includesTokenDigests).toBe(true);
    expect(withTokens.tables.api_tokens?.rows.length).toBeGreaterThan(0);
    // Digests only: the token itself is never stored.
    expect(JSON.stringify(withTokens)).not.toContain(
      world.principals.owner.token,
    );

    const fresh = openSqliteDatabase(join(tempDir(), 'y.sqlite'));
    restoreBackup(fresh, withTokens, migrations());
    expect(
      fresh.get<{ n: number }>('SELECT COUNT(*) AS n FROM api_tokens')?.n,
    ).toBeGreaterThan(0);
    fresh.close();
    world.close();
  });

  it('never exports sessions or replay results', async () => {
    const { world } = await populated();
    const backup = exportBackup(world.db);
    for (const name of [
      'mcp_sessions',
      'mcp_idempotency',
      'runner_claim_backoff',
      'schema_migrations',
    ]) {
      expect(backup.tables[name]).toBeUndefined();
    }
    world.close();
  });
});

describe('a backup does not stop the server writing', () => {
  it('reads from a snapshot, so a writer on another connection is not blocked and is not in the file', async () => {
    const { world } = await populated();
    const writer = openSqliteDatabase(world.dbPath);
    const reader = openSqliteDatabase(world.dbPath);
    const spy = vi.spyOn(reader, 'readTransaction');
    try {
      const countBefore =
        reader.get<{ n: number }>('SELECT COUNT(*) AS n FROM workspaces')?.n ??
        0;
      let backup: ReturnType<typeof exportBackup> | undefined;
      reader.readTransaction?.((tx) => {
        expect(
          tx.get<{ n: number }>('SELECT COUNT(*) AS n FROM workspaces')?.n,
        ).toBe(countBefore);
        // The write lock is free: this would wait out busy_timeout and then fail if the reader held it.
        const started = Date.now();
        writer.run(
          "INSERT INTO workspaces (id, name, created_at) VALUES ('ws_late', 'late', 'z')",
        );
        expect(Date.now() - started).toBeLessThan(1000);
        // And the snapshot does not see it.
        expect(
          tx.get<{ n: number }>('SELECT COUNT(*) AS n FROM workspaces')?.n,
        ).toBe(countBefore);
      });
      backup = exportBackup(reader);
      expect(spy).toHaveBeenCalledTimes(2);
      // exportBackup took the read path, not the write lock, and holds the late workspace now.
      expect(backup.tables.workspaces?.rows.length).toBe(countBefore + 1);
    } finally {
      writer.close();
      reader.close();
      world.close();
    }
  });

  it('can still be taken from a store whose guard refuses writes', async () => {
    const { world } = await populated();
    const { guardStorage } = await import('../../src/ops/index.js');
    const guarded = guardStorage(openSqliteDatabase(world.dbPath));
    try {
      expect(() =>
        guarded.run('UPDATE workspaces SET name = name'),
      ).not.toThrow();
      guarded.quota.reset();
      expect(
        exportBackup(guarded).tables.missions?.rows.length,
      ).toBeGreaterThan(0);
    } finally {
      guarded.close();
      world.close();
    }
  });
});

describe('refusing a backup that cannot be trusted', () => {
  it('rejects an edited file by its digest, and a file that is not a backup', async () => {
    const { world } = await populated();
    const backup = exportBackup(world.db);
    const edited = JSON.parse(JSON.stringify(backup));
    const missions = edited.tables.missions;
    const titleIndex = missions.columns.indexOf('title');
    missions.rows[0][titleIndex] = 'tampered';
    expect(() => readBackup(JSON.stringify(edited))).toThrow(/digest/);
    expect(() => readBackup('{')).toThrow(BackupError);
    expect(() => readBackup('{"format":"other"}')).toThrow(
      /not a tower\.backup/,
    );
    const ragged = JSON.parse(JSON.stringify(backup));
    ragged.tables.missions.rows[0].pop();
    expect(() => readBackup(JSON.stringify(ragged))).toThrow(/malformed/);
    world.close();
  });

  it('refuses a restore into a store that already has data, or from a different schema history', async () => {
    const { world } = await populated();
    const backup = exportBackup(world.db);
    expect(() => restoreBackup(world.db, backup, migrations())).toThrow(
      /already holds data/,
    );

    const other = migrations().map((m, i) =>
      i === 1 ? { ...m, sql: `${m.sql}\n-- changed` } : m,
    );
    const fresh = openSqliteDatabase(join(tempDir(), 'z.sqlite'));
    expect(() => restoreBackup(fresh, backup, other)).toThrow(
      /not the one this build has/,
    );
    fresh.close();

    const newer = {
      ...backup,
      migrations: [...backup.migrations, { id: '0099_future', checksum: 'x' }],
    };
    const target = openSqliteDatabase(join(tempDir(), 'w.sqlite'));
    expect(() => restoreBackup(target, newer, migrations())).toThrow(
      /newer build/,
    );
    target.close();
    world.close();
  });

  it('refuses rows that break a foreign key, even with a valid digest', async () => {
    const { world } = await populated();
    const backup = exportBackup(world.db);
    const bad = JSON.parse(JSON.stringify(backup));
    // Drop every principal. The digest is recomputed so only the foreign-key check can catch it.
    bad.tables.principals.rows = [];
    bad.digest = createHash('sha256')
      .update(
        JSON.stringify(
          Object.keys(bad.tables)
            .sort()
            .map((name) => [name, bad.tables[name]]),
        ),
      )
      .digest('hex');
    const fresh = openSqliteDatabase(join(tempDir(), 'fk.sqlite'));
    expect(() => restoreBackup(fresh, bad, migrations())).toThrow(
      /foreign key/,
    );
    fresh.close();
    world.close();
  });
});

describe('a backup edited and re-digested by someone who can write the file', () => {
  const redigest = (backup: ReturnType<typeof exportBackup>) => {
    const edited = JSON.parse(JSON.stringify(backup));
    edited.digest = createHash('sha256')
      .update(
        JSON.stringify(
          Object.keys(edited.tables)
            .sort()
            .map((name) => [name, edited.tables[name]]),
        ),
      )
      .digest('hex');
    return edited;
  };

  it('cannot plant a credential in a file that says it holds no token digests', async () => {
    const { world } = await populated();
    const plain = exportBackup(world.db);
    const withTokens = exportBackup(world.db, { includeTokenDigests: true });
    const planted = redigest({
      ...plain,
      tables: { ...plain.tables, api_tokens: withTokens.tables.api_tokens },
    } as typeof plain);
    expect(readBackup(JSON.stringify(planted))).toBeDefined();
    const fresh = openSqliteDatabase(join(tempDir(), 'planted.sqlite'));
    expect(() => restoreBackup(fresh, planted, migrations())).toThrow(
      /api_tokens but says it has no token digests/,
    );
    fresh.close();
    world.close();
  });

  it('cannot carry tables a backup never contains, such as a doctored migration record', async () => {
    const { world } = await populated();
    const backup = exportBackup(world.db);
    for (const name of [
      'schema_migrations',
      'mcp_sessions',
      'mcp_idempotency',
      'runner_claim_backoff',
    ]) {
      const forged = redigest({
        ...backup,
        tables: {
          ...backup.tables,
          [name]: { columns: ['id'], rows: [['x']] },
        },
      } as typeof backup);
      const fresh = openSqliteDatabase(join(tempDir(), `${name}.sqlite`));
      expect(() => restoreBackup(fresh, forged, migrations()), name).toThrow(
        /never contains/,
      );
      fresh.close();
    }
    world.close();
  });

  it('still restores a file that says it holds token digests, when it does', async () => {
    const { world } = await populated();
    const fresh = openSqliteDatabase(join(tempDir(), 'ok.sqlite'));
    expect(
      restoreBackup(
        fresh,
        exportBackup(world.db, { includeTokenDigests: true }),
        migrations(),
      ).rows,
    ).toBeGreaterThan(0);
    fresh.close();
    world.close();
  });
});

describe('schema migration forward', () => {
  it('restores a backup from an older schema, migrates it forward, and keeps the data', async () => {
    // A store that ran every migration but the last, with data in a table the last one alters.
    const old = openSqliteDatabase(join(tempDir(), 'old.sqlite'));
    const all = migrations();
    const older = all.slice(0, -1);
    expect(all.at(-1)?.id).toBe('0009_hardening');
    applyMigrations(old, older);
    old.run(
      "INSERT INTO workspaces (id, name, created_at) VALUES ('ws_old', 'old', '2026-01-01T00:00:00Z')",
    );
    old.run(
      "INSERT INTO webhook_deliveries (workspace_id, provider, delivery_id, event, outcome, received_at) VALUES ('ws_old', 'github', 'd1', 'issues', 'processed', '2026-01-01T00:00:00Z')",
    );
    const backup = exportBackup(old);
    expect(backup.migrations).toHaveLength(older.length);
    expect(backup.tables.webhook_deliveries?.columns).not.toContain(
      'payload_hash',
    );

    const fresh = openSqliteDatabase(join(tempDir(), 'new.sqlite'));
    const result = restoreBackup(fresh, backup, all);
    expect(result.migratedForward).toEqual(['0009_hardening']);
    expect(
      fresh.get<{ delivery_id: string; payload_hash: string | null }>(
        'SELECT delivery_id, payload_hash FROM webhook_deliveries',
      ),
    ).toEqual({ delivery_id: 'd1', payload_hash: null });
    // The new tables exist and work.
    expect(fresh.all('SELECT * FROM ops_halt')).toEqual([]);
    // A second migrate run is a no-op.
    expect(applyMigrations(fresh, all)).toEqual([]);
    old.close();
    fresh.close();
  });

  it('refuses to run when an applied migration was edited, so a rollback is a restore and never a rewrite', () => {
    const db = openSqliteDatabase(':memory:');
    applyMigrations(db, migrations());
    const edited = migrations().map((m) =>
      m.id === '0009_hardening' ? { ...m, sql: `${m.sql}\n-- edit` } : m,
    );
    expect(() => applyMigrations(db, edited)).toThrow(
      /changed after it was applied/,
    );
  });
});

describe('pnpm ops', () => {
  function run(args: string[], env: Record<string, string> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const code = runOpsCli(args, env, {
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  it('backs up, verifies and restores through files, with owner-only permissions and no overwrite', async () => {
    const { world } = await populated();
    const dir = tempDir();
    const file = join(dir, 'tower.backup.json');
    const made = run(['backup', '--db', world.dbPath, '--out', file]);
    expect(made.code).toBe(0);
    expect(made.out).toMatch(/Backed up \d+ tables, \d+ migrations/);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(run(['backup', '--db', world.dbPath, '--out', file]).err).toMatch(
      /Refusing to overwrite/,
    );

    expect(run(['verify', '--from', file]).out).toMatch(/Backup is intact/);
    const target = join(dir, 'restored.sqlite');
    const restored = run(['restore', '--from', file, '--db', target]);
    expect(restored.code).toBe(0);
    expect(restored.out).toMatch(/No tokens were restored/);
    expect(run(['restore', '--from', file, '--db', target]).err).toMatch(
      /Refusing to restore over/,
    );

    const copy = openSqliteDatabase(target);
    expect(storeFingerprint(copy).digest).toBe(
      storeFingerprint(world.db).digest,
    );
    copy.close();

    // An edit anywhere in the file makes `verify` and `restore` refuse it.
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replace('Backed up', 'Edited up'),
    );
    const damaged = run(['verify', '--from', file]);
    expect(damaged.code).toBe(1);
    expect(damaged.err).toMatch(/digest/);
    const again = join(dir, 'again.sqlite');
    expect(run(['restore', '--from', file, '--db', again]).code).toBe(1);
    expect(existsSync(again)).toBe(false);
    world.close();
  });

  it('leaves nothing behind when a restore fails, so the retry the error advises is not blocked', async () => {
    const { world } = await populated();
    const dir = tempDir();
    const file = join(dir, 'newer.json');
    const backup = exportBackup(world.db);
    // A backup from a newer build: restoreBackup refuses it after the target file was created.
    writeFileSync(
      file,
      JSON.stringify({
        ...backup,
        migrations: [
          ...backup.migrations,
          { id: '0099_future', checksum: 'x' },
        ],
      }),
    );
    const target = join(dir, 'restored.sqlite');
    const failed = run(['restore', '--from', file, '--db', target]);
    expect(failed.code).toBe(1);
    expect(failed.err).toMatch(/newer build/);
    for (const suffix of ['', '-wal', '-shm']) {
      expect(existsSync(`${target}${suffix}`), suffix || 'main file').toBe(
        false,
      );
    }
    // The same command with a good backup then works at that path.
    const good = join(dir, 'good.json');
    writeFileSync(good, JSON.stringify(backup));
    expect(run(['restore', '--from', good, '--db', target]).code).toBe(0);
    world.close();
  });

  it('does not call a database healthy that it cannot see the signals of', async () => {
    const { world } = await populated();
    const status = JSON.parse(
      run(['status', '--db', world.dbPath, '--workspace', TEST_WORKSPACE]).out,
    );
    expect(status.status).toBe('not_halted');
    expect(status.status).not.toBe('ok');
    expect(status.signals).toMatch(/running server/);
    expect(status.signals).toMatch(/read_health/);
    world.close();
  });

  it('creates a missing backup directory, owner-only, and names the cause when it cannot write', async () => {
    const { world } = await populated();
    const dir = tempDir();
    const nested = join(dir, 'backups', 'nightly', 'tower.json');
    const made = run(['backup', '--db', world.dbPath, '--out', nested]);
    expect(made.code).toBe(0);
    expect(statSync(join(dir, 'backups', 'nightly')).mode & 0o777).toBe(0o700);
    expect(existsSync(nested)).toBe(true);
    // A parent that is a file: the error carries the file-system code, and no path or content.
    const blocked = run([
      'backup',
      '--db',
      world.dbPath,
      '--out',
      join(nested, 'x.json'),
    ]);
    expect(blocked.code).toBe(1);
    expect(blocked.err).toMatch(/ops failed: Error \((ENOTDIR|EEXIST)\)/);
    world.close();
  });

  it('halts and resumes by a human principal, and reports status', async () => {
    const { world } = await populated();
    const owner = world.principals.owner.id;
    const cos = world.principals.cos.id;
    const ws = TEST_WORKSPACE;
    const base = ['--db', world.dbPath, '--workspace', ws];
    expect(run(['halt', ...base, '--actor', cos]).err).toMatch(/Only a person/);
    const halted = run([
      'halt',
      ...base,
      '--actor',
      owner,
      '--reason',
      'drill',
    ]);
    expect(halted.out).toMatch(/is halted/);
    expect(JSON.parse(run(['status', ...base]).out)).toMatchObject({
      status: 'halted',
      halt: { reason: 'drill' },
    });
    expect(run(['resume', ...base, '--actor', owner]).out).toMatch(
      /is running/,
    );
    expect(run(['halt', ...base, '--actor', 'prn_nobody']).err).toMatch(
      /No enabled principal/,
    );
    expect(run(['halt', ...base]).code).toBe(2);
    expect(run(['status', '--db', join(tempDir(), 'none.sqlite')]).code).toBe(
      1,
    );
    expect(existsSync(join(tempDir(), 'none.sqlite'))).toBe(false);
    world.close();
  });

  it('prints usage for an unknown command', () => {
    expect(run(['nope']).code).toBe(2);
    expect(run(['--bogus']).code).toBe(2);
  });
});
