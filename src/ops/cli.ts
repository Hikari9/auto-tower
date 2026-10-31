import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { getPrincipal } from '../auth/principals.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  defaultMigrationsDir,
  readMigrationFiles,
} from '../storage/migration-files.js';
import { openSqliteDatabase } from '../storage/sqlite.js';
import {
  assertRestorable,
  BackupError,
  exportBackup,
  readBackup,
  restoreBackup,
} from './backup.js';
import { engageHalt, HaltForbiddenError, liftHalt } from './halt.js';
import { healthReport } from './health.js';
import {
  disablePrincipal,
  RevocationError,
  revokeTokenById,
} from './revoke.js';

const DEFAULT_DB_PATH = '.tower/tower.sqlite';
const DEFAULT_WORKSPACE = 'default';

const USAGE = [
  'Usage: pnpm ops <command> [options]',
  '  backup  --out <file> [--db <path>] [--include-token-digests]',
  '          Writes every canonical table to one JSON file (mode 0600). Refuses to overwrite.',
  '  verify  --from <file>',
  '          Checks a backup against its digest and lists what it holds.',
  '  restore --from <file> --db <new path> [--restore-token-digests]',
  '          Restores into a database that does not exist yet, then migrates it forward.',
  '  halt    --actor <human principal id> [--reason <text>] [--workspace <id>] [--db <path>]',
  '  resume  --actor <human principal id> [--reason <text>] [--workspace <id>] [--db <path>]',
  '  revoke-token     --actor <human principal id> --token-id <id> [--reason <text>] [--workspace <id>] [--db <path>]',
  '  disable-principal --actor <human principal id> --principal <id> [--reason <text>] [--workspace <id>] [--db <path>]',
  '          Revokes every token the principal holds and refuses its credentials from the next request.',
  '  status  [--workspace <id>] [--db <path>]',
  '',
  'Defaults: --db $TOWER_DB_PATH or .tower/tower.sqlite, --workspace $TOWER_WORKSPACE or "default".',
].join('\n');

/**
 * Creates `path` empty, and fails with EEXIST if anything is already there, so the caller owns
 * what it made. Nothing else could have created it between a check and this call.
 */
export function createNewFile(path: string): void {
  closeSync(openSync(path, 'wx', 0o600));
}

export interface OpsIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const OPTIONS = {
  db: { type: 'string' },
  out: { type: 'string' },
  from: { type: 'string' },
  actor: { type: 'string' },
  reason: { type: 'string' },
  workspace: { type: 'string' },
  'token-id': { type: 'string' },
  principal: { type: 'string' },
  'include-token-digests': { type: 'boolean' },
  'restore-token-digests': { type: 'boolean' },
} as const;

/** Runs one ops command and returns the process exit code. Works on a database file; the server need not run. */
export function runOpsCli(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: OpsIo,
): number {
  let parsed: ReturnType<
    typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>
  >;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: OPTIONS,
      allowPositionals: true,
    });
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    io.stderr(USAGE);
    return 2;
  }
  const { values, positionals } = parsed;
  const command = positionals[0];
  const dbPath = values.db ?? (env.TOWER_DB_PATH || DEFAULT_DB_PATH);
  const workspaceId =
    values.workspace ?? (env.TOWER_WORKSPACE || DEFAULT_WORKSPACE);
  const need = (
    value: string | undefined,
    flag: string,
  ): string | undefined => {
    if (value === undefined || value === '') {
      io.stderr(`${command} needs --${flag}`);
      return undefined;
    }
    return value;
  };

  try {
    switch (command) {
      case 'backup': {
        const out = need(values.out, 'out');
        if (out === undefined) {
          return 2;
        }
        if (!existsSync(dbPath)) {
          io.stderr(`No database at ${dbPath}`);
          return 1;
        }
        if (existsSync(out)) {
          io.stderr(`Refusing to overwrite ${out}`);
          return 1;
        }
        const db = openSqliteDatabase(dbPath);
        try {
          const backup = exportBackup(db, {
            includeTokenDigests: values['include-token-digests'] === true,
          });
          mkdirSync(dirname(out), { recursive: true, mode: 0o700 });
          // `wx` fails if the file appeared since the check, and the mode keeps it owner-only.
          writeFileSync(out, JSON.stringify(backup), {
            flag: 'wx',
            mode: 0o600,
          });
          io.stdout(
            `Backed up ${Object.keys(backup.tables).length} tables, ${backup.migrations.length} migrations to ${out}`,
          );
          io.stdout(`digest ${backup.digest}`);
          if (backup.includesTokenDigests) {
            io.stdout(
              'This file holds token digests. Keep it as private as the database.',
            );
          }
        } finally {
          db.close();
        }
        return 0;
      }
      case 'verify': {
        const from = need(values.from, 'from');
        if (from === undefined) {
          return 2;
        }
        const backup = readBackup(readFileSync(from, 'utf8'));
        const rows = Object.values(backup.tables).reduce(
          (n, t) => n + t.rows.length,
          0,
        );
        io.stdout(
          `Backup is intact: ${Object.keys(backup.tables).length} tables, ${rows} rows, schema ${backup.migrations.at(-1)?.id ?? 'empty'}, made ${backup.createdAt}`,
        );
        return 0;
      }
      case 'restore': {
        const from = need(values.from, 'from');
        if (from === undefined) {
          return 2;
        }
        if (existsSync(dbPath)) {
          io.stderr(
            `Refusing to restore over ${dbPath}: restore into a path that does not exist yet`,
          );
          return 1;
        }
        const backup = readBackup(readFileSync(from, 'utf8'));
        const migrationFiles = readMigrationFiles(defaultMigrationsDir());
        const options = {
          allowTokenDigests: values['restore-token-digests'] === true,
        };
        // Refused before anything is created: no directory, no file, nothing to clean up.
        assertRestorable(backup, migrationFiles, options);
        // Created exclusively, so this command owns the file. If anything else made it first the
        // command stops, and a failed restore removes only a file this command made.
        mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
        createNewFile(dbPath);
        let restored = false;
        let db: ReturnType<typeof openSqliteDatabase> | undefined;
        try {
          // Inside the try: opening refuses an unsafe directory, and the file made above must go.
          db = openSqliteDatabase(dbPath);
          const result = restoreBackup(db, backup, migrationFiles, options);
          restored = true;
          io.stdout(
            `Restored ${result.rows} rows into ${dbPath}; migrated forward ${result.migratedForward.length} step(s)`,
          );
          if (!options.allowTokenDigests) {
            io.stdout(
              'No tokens were restored. Issue new ones with `pnpm tower token create --db ' +
                dbPath +
                '`, and enroll runners again.',
            );
          }
        } finally {
          db?.close();
          // A restore that failed leaves nothing: not a half-loaded file the server would open as
          // a database, and not a path that blocks the retry the error message advises.
          if (!restored) {
            for (const suffix of ['', '-wal', '-shm']) {
              rmSync(`${dbPath}${suffix}`, { force: true });
            }
          }
        }
        return 0;
      }
      case 'halt':
      case 'resume': {
        const actorId = need(values.actor, 'actor');
        if (actorId === undefined) {
          return 2;
        }
        if (!existsSync(dbPath)) {
          io.stderr(`No database at ${dbPath}`);
          return 1;
        }
        const db = openSqliteDatabase(dbPath);
        try {
          applyMigrations(db, readMigrationFiles(defaultMigrationsDir()));
          const principal = getPrincipal(db, actorId);
          if (
            principal === undefined ||
            principal.workspaceId !== workspaceId ||
            principal.disabledAt !== null
          ) {
            io.stderr(
              `No enabled principal ${actorId} in workspace ${workspaceId}`,
            );
            return 1;
          }
          const input = {
            workspaceId,
            actor: { id: principal.id, kind: principal.kind },
            reason: values.reason ?? null,
          };
          const state =
            command === 'halt' ? engageHalt(db, input) : liftHalt(db, input);
          io.stdout(
            state.halted
              ? `Workspace ${workspaceId} is halted`
              : `Workspace ${workspaceId} is running`,
          );
        } finally {
          db.close();
        }
        return 0;
      }
      case 'revoke-token':
      case 'disable-principal': {
        const actorId = need(values.actor, 'actor');
        const targetFlag =
          command === 'revoke-token' ? 'token-id' : 'principal';
        const target = need(
          command === 'revoke-token' ? values['token-id'] : values.principal,
          targetFlag,
        );
        if (actorId === undefined || target === undefined) {
          return 2;
        }
        if (!existsSync(dbPath)) {
          io.stderr(`No database at ${dbPath}`);
          return 1;
        }
        const db = openSqliteDatabase(dbPath);
        try {
          applyMigrations(db, readMigrationFiles(defaultMigrationsDir()));
          const principal = getPrincipal(db, actorId);
          if (
            principal === undefined ||
            principal.workspaceId !== workspaceId ||
            principal.disabledAt !== null
          ) {
            io.stderr(
              `No enabled principal ${actorId} in workspace ${workspaceId}`,
            );
            return 1;
          }
          const common = {
            workspaceId,
            actor: { id: principal.id, kind: principal.kind },
            reason: values.reason ?? null,
          };
          if (command === 'revoke-token') {
            const result = revokeTokenById(db, { ...common, tokenId: target });
            io.stdout(
              result.revoked
                ? `Token ${target} is revoked`
                : `Token ${target} was already revoked`,
            );
          } else {
            const result = disablePrincipal(db, {
              ...common,
              principalId: target,
            });
            io.stdout(
              `Principal ${target} is disabled; ${result.tokensRevoked} token(s) revoked`,
            );
          }
        } finally {
          db.close();
        }
        return 0;
      }
      case 'status': {
        if (!existsSync(dbPath)) {
          io.stderr(`No database at ${dbPath}`);
          return 1;
        }
        const db = openSqliteDatabase(dbPath);
        try {
          // Signals live in the running server's memory, and this is another process. Reporting "ok"
          // from here would say an incident is over when it cannot be seen, so only what the file
          // holds is reported, and the rest is pointed at the server.
          const { halt, storageReadable } = healthReport(db, workspaceId);
          io.stdout(
            JSON.stringify(
              {
                status: halt.halted ? 'halted' : 'not_halted',
                halt,
                storageReadable,
                signals:
                  'not visible from this command: they live in the running server. Ask it with the read_health tool.',
              },
              null,
              2,
            ),
          );
        } finally {
          db.close();
        }
        return 0;
      }
      default:
        io.stderr(USAGE);
        return command === undefined || command === 'help' ? 0 : 2;
    }
  } catch (error) {
    if (
      error instanceof BackupError ||
      error instanceof HaltForbiddenError ||
      error instanceof RevocationError
    ) {
      io.stderr(error.message);
      return 1;
    }
    // A file-system code names a cause and no secret, and tells the operator what to fix.
    const code = (error as { code?: unknown } | null)?.code;
    const cause =
      error instanceof RangeError
        ? ' (too large for one backup file)'
        : typeof code === 'string' && /^E[A-Z]+$/.test(code)
          ? ` (${code})`
          : '';
    io.stderr(
      `ops failed: ${error instanceof Error ? error.name : 'error'}${cause}`,
    );
    return 1;
  }
}
