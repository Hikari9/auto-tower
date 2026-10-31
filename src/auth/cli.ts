import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { applyMigrations } from '../storage/migrate.js';
import {
  defaultMigrationsDir,
  readMigrationFiles,
} from '../storage/migration-files.js';
import { openSqliteDatabase } from '../storage/sqlite.js';
import {
  createPrincipal,
  ensureWorkspace,
  isPrincipalKind,
  isScope,
  PRINCIPAL_KINDS,
  type Scope,
} from './principals.js';
import { issueToken } from './tokens.js';

const DEFAULT_DB_PATH = '.tower/tower.sqlite';
const DEFAULT_WORKSPACE = 'default';

const USAGE = [
  'Usage: pnpm tower token create --kind <kind> [options]',
  `  --kind <${PRINCIPAL_KINDS.join('|')}>`,
  '  --name <label>            default: the kind',
  '  --workspace <id>          default: $TOWER_WORKSPACE or "default"',
  '  --scopes <a,b,...>        default: every scope the kind allows',
  '  --expires-in-days <n>     default: no expiry',
  '  --db <path>               default: $TOWER_DB_PATH or .tower/tower.sqlite',
].join('\n');

export interface CliIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const OPTIONS = {
  kind: { type: 'string' },
  name: { type: 'string' },
  workspace: { type: 'string' },
  scopes: { type: 'string' },
  'expires-in-days': { type: 'string' },
  db: { type: 'string' },
} as const;

function parseCliArgs(argv: readonly string[]) {
  try {
    return parseArgs({
      args: [...argv],
      options: OPTIONS,
      allowPositionals: true,
    });
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

/** Runs one CLI command and returns the process exit code. Bootstraps owner tokens locally. */
export function runCli(
  argv: readonly string[],
  io: CliIo,
  env: Readonly<Record<string, string | undefined>> = process.env,
  now: Date = new Date(),
): number {
  const parsed = parseCliArgs(argv);
  if (parsed instanceof Error) {
    io.stderr(parsed.message);
    io.stderr(USAGE);
    return 2;
  }
  const { values, positionals } = parsed;
  if (positionals[0] !== 'token' || positionals[1] !== 'create') {
    io.stderr(USAGE);
    return 2;
  }
  const kind = values.kind;
  if (!isPrincipalKind(kind)) {
    io.stderr(`--kind must be one of: ${PRINCIPAL_KINDS.join(', ')}`);
    return 2;
  }
  const scopes = parseScopes(values.scopes);
  if (scopes === 'invalid') {
    io.stderr('--scopes contains an unknown scope');
    return 2;
  }
  const expiresAt = parseExpiry(values['expires-in-days'], now);
  if (expiresAt === 'invalid') {
    io.stderr('--expires-in-days must be a positive number');
    return 2;
  }

  // `||` rather than `??`: an empty value means unset, not an empty path or id.
  const workspaceId =
    values.workspace || env.TOWER_WORKSPACE || DEFAULT_WORKSPACE;
  const db = openSqliteDatabase(
    values.db || env.TOWER_DB_PATH || DEFAULT_DB_PATH,
  );
  try {
    applyMigrations(db, readMigrationFiles(defaultMigrationsDir()));
    let issued: ReturnType<typeof issueToken>;
    try {
      issued = db.transaction((tx) => {
        ensureWorkspace(tx, workspaceId, workspaceId);
        const principal = createPrincipal(tx, {
          workspaceId,
          kind,
          name: values.name || kind,
        });
        return issueToken(tx, {
          principalId: principal.id,
          scopes,
          expiresAt,
          now,
        });
      });
    } catch (error) {
      // The transaction rolled back, so no principal or token row was written.
      io.stderr(
        `Token not issued: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 2;
    }
    io.stdout(`token: ${issued.token}`);
    io.stdout(`id: ${issued.id}`);
    io.stdout(
      `principal: ${issued.principal.id} (${issued.principal.kind}) in ${workspaceId}`,
    );
    io.stdout(`scopes: ${issued.scopes.join(', ')}`);
    io.stdout(`expires: ${issued.expiresAt ?? 'never'}`);
    io.stderr(
      'Store the token now. It is stored only as a hash and cannot be shown again.',
    );
    return 0;
  } finally {
    db.close();
  }
}

function parseScopes(raw: string | undefined): Scope[] | undefined | 'invalid' {
  if (raw === undefined) {
    return undefined;
  }
  const scopes = raw
    .split(',')
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
  return scopes.length > 0 && scopes.every(isScope) ? scopes : 'invalid';
}

function parseExpiry(
  raw: string | undefined,
  now: Date,
): Date | undefined | 'invalid' {
  if (raw === undefined) {
    return undefined;
  }
  const days = Number(raw);
  if (!Number.isFinite(days) || days <= 0) {
    return 'invalid';
  }
  // Huge day counts overflow Date; treat them as invalid rather than throwing later.
  const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  return Number.isNaN(expiresAt.getTime()) ? 'invalid' : expiresAt;
}

// Runs only when this file is the entry point, not when tests import it.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  process.exitCode = runCli(process.argv.slice(2), {
    stdout: (line) => console.log(line),
    stderr: (line) => console.error(line),
  });
}
