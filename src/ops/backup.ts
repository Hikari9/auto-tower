import { createHash } from 'node:crypto';
import type { SqlDatabase, SqlValue } from '../storage/database.js';
import { applyMigrations, type Migration } from '../storage/migrate.js';

/**
 * Backup and restore of Tower's canonical state to one portable JSON file.
 *
 * The file holds every table that carries state a person or an auditor would want back: missions,
 * their events and projection, policy, decisions and their links, issue links, runners and their
 * leases and receipts, and every audit table. It leaves out what is rebuilt or must not travel:
 * MCP sessions and replay results, claim backoff, and (unless asked) API token digests.
 *
 * A backup records which migrations the store had run, with their checksums. Restoring replays
 * exactly those into a fresh store, loads the rows, proves the loaded rows match the file, and only
 * then migrates forward to the current schema. So an old backup restores into a new build, and a
 * backup from a different schema history is refused instead of loaded wrongly.
 */

export const BACKUP_FORMAT = 'tower.backup.v1';

/** Never exported: rebuilt on demand, or short-lived by design. */
const EPHEMERAL_TABLES: readonly string[] = [
  'schema_migrations',
  'mcp_sessions',
  'mcp_idempotency',
  'runner_claim_backoff',
];

/** Credential digests. Exported only when the caller asks, since the file then holds the means to sign in. */
const CREDENTIAL_TABLES: readonly string[] = ['api_tokens'];

type Cell = string | number | { $bigint: string } | null;

export interface BackupTable {
  columns: string[];
  rows: Cell[][];
}

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  createdAt: string;
  /** Migrations the source store had run, in order. */
  migrations: Array<{ id: string; checksum: string }>;
  includesTokenDigests: boolean;
  tables: Record<string, BackupTable>;
  /** SHA-256 over `tables`, so a damaged or edited file is refused. */
  digest: string;
}

export class BackupError extends Error {
  override readonly name = 'BackupError';
  constructor(
    readonly code:
      | 'invalid_file'
      | 'digest_mismatch'
      | 'schema_mismatch'
      | 'target_not_empty'
      | 'verification_failed',
    message: string,
  ) {
    super(message);
  }
}

const checksumOf = (migration: Migration): string =>
  createHash('sha256').update(migration.sql).digest('hex');

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function encode(value: SqlValue): Cell {
  if (typeof value === 'bigint') {
    return Number.isSafeInteger(Number(value))
      ? Number(value)
      : { $bigint: value.toString() };
  }
  return value;
}

function decode(cell: Cell): SqlValue {
  return typeof cell === 'object' && cell !== null
    ? BigInt(cell.$bigint)
    : cell;
}

function tableNames(db: SqlDatabase): string[] {
  return db
    .all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .map((row) => row.name);
}

function dumpTable(db: SqlDatabase, name: string): BackupTable {
  const columns = db
    .all<{ name: string }>(
      `SELECT name FROM pragma_table_info(${quoteLiteral(name)})`,
    )
    .map((row) => row.name);
  const rows = db
    .all<Record<string, SqlValue>>(
      `SELECT ${columns.map(quote).join(', ')} FROM ${quote(name)} ORDER BY rowid`,
    )
    .map((row) => columns.map((column) => encode(row[column] as SqlValue)));
  return { columns, rows };
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function digestOf(tables: Record<string, BackupTable>): string {
  const sorted = Object.keys(tables)
    .sort()
    .map((name) => [name, tables[name]]);
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

function selectedTables(db: SqlDatabase, includeTokenDigests: boolean) {
  return tableNames(db).filter(
    (name) =>
      !EPHEMERAL_TABLES.includes(name) &&
      (includeTokenDigests || !CREDENTIAL_TABLES.includes(name)),
  );
}

/**
 * Reads the whole store inside one transaction, so the file is a single consistent moment. Writers
 * wait for the few milliseconds the read takes.
 */
export function exportBackup(
  db: SqlDatabase,
  options: { now?: Date; includeTokenDigests?: boolean } = {},
): BackupFile {
  const includeTokenDigests = options.includeTokenDigests === true;
  return db.transaction((tx) => {
    const migrations = tx
      .all<{ id: string; checksum: string }>(
        'SELECT id, checksum FROM schema_migrations ORDER BY id',
      )
      .map((row) => ({ id: row.id, checksum: row.checksum }));
    const tables: Record<string, BackupTable> = {};
    for (const name of selectedTables(tx, includeTokenDigests)) {
      tables[name] = dumpTable(tx, name);
    }
    return {
      format: BACKUP_FORMAT,
      createdAt: (options.now ?? new Date()).toISOString(),
      migrations,
      includesTokenDigests: includeTokenDigests,
      tables,
      digest: digestOf(tables),
    };
  });
}

function isBackupFile(value: unknown): value is BackupFile {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const file = value as Partial<BackupFile>;
  return (
    file.format === BACKUP_FORMAT &&
    Array.isArray(file.migrations) &&
    typeof file.digest === 'string' &&
    typeof file.tables === 'object' &&
    file.tables !== null
  );
}

/** Parses and checks a backup's shape and digest without touching any store. */
export function readBackup(text: string): BackupFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BackupError('invalid_file', 'The backup is not valid JSON');
  }
  if (!isBackupFile(parsed)) {
    throw new BackupError(
      'invalid_file',
      `The file is not a ${BACKUP_FORMAT} backup`,
    );
  }
  for (const [name, table] of Object.entries(parsed.tables)) {
    if (
      !Array.isArray(table?.columns) ||
      !Array.isArray(table?.rows) ||
      table.rows.some(
        (row) => !Array.isArray(row) || row.length !== table.columns.length,
      )
    ) {
      throw new BackupError('invalid_file', `Table ${name} is malformed`);
    }
  }
  if (digestOf(parsed.tables) !== parsed.digest) {
    throw new BackupError(
      'digest_mismatch',
      'The backup does not match its digest: it was edited or damaged',
    );
  }
  return parsed;
}

export interface RestoreResult {
  /** Migrations replayed to reach the backup's schema. */
  replayed: string[];
  /** Migrations applied after loading, to bring an older backup forward. */
  migratedForward: string[];
  rows: number;
}

/**
 * Restores a backup into a fresh store. The store must have no workspaces. Migrations are the
 * build's own: the backup's must be a prefix of them with the same checksums.
 */
export function restoreBackup(
  db: SqlDatabase,
  backup: BackupFile,
  migrations: readonly Migration[],
): RestoreResult {
  if (digestOf(backup.tables) !== backup.digest) {
    throw new BackupError(
      'digest_mismatch',
      'The backup does not match its digest',
    );
  }
  const wanted = backup.migrations;
  if (wanted.length > migrations.length) {
    throw new BackupError(
      'schema_mismatch',
      `The backup was made by a newer build (${wanted.length} migrations, this build has ${migrations.length}). Restore it with that build or newer.`,
    );
  }
  for (const [index, entry] of wanted.entries()) {
    const own = migrations[index];
    if (
      own === undefined ||
      own.id !== entry.id ||
      checksumOf(own) !== entry.checksum
    ) {
      throw new BackupError(
        'schema_mismatch',
        `Migration ${entry.id} in the backup is not the one this build has at that position`,
      );
    }
  }
  const replayed = applyMigrations(db, migrations.slice(0, wanted.length));
  const existing = db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM workspaces',
  );
  if ((existing?.n ?? 0) > 0) {
    throw new BackupError(
      'target_not_empty',
      'The target store already holds data. Restore into a fresh database.',
    );
  }

  const known = new Set(tableNames(db));
  const included = Object.keys(backup.tables);
  for (const name of included) {
    // The digest is not a signature: anyone who can edit the file can recompute it. So the file is
    // held to what an export can contain. A table an export never writes, or token digests in a
    // file that says it has none, would let an edited backup plant a credential or a migration.
    if (EPHEMERAL_TABLES.includes(name)) {
      throw new BackupError(
        'invalid_file',
        `The backup holds ${name}, which a backup never contains`,
      );
    }
    if (CREDENTIAL_TABLES.includes(name) && !backup.includesTokenDigests) {
      throw new BackupError(
        'invalid_file',
        `The backup holds ${name} but says it has no token digests`,
      );
    }
    if (!known.has(name)) {
      throw new BackupError(
        'schema_mismatch',
        `The backup has a table this schema lacks: ${name}`,
      );
    }
  }
  // Rows go in with foreign keys off and are checked as a whole afterwards, since the file's
  // table order says nothing about which table refers to which.
  db.exec('PRAGMA foreign_keys = OFF');
  let rows = 0;
  try {
    db.transaction((tx) => {
      for (const name of included) {
        const table = backup.tables[name];
        if (table === undefined || table.rows.length === 0) {
          continue;
        }
        const insert = `INSERT INTO ${quote(name)} (${table.columns.map(quote).join(', ')}) VALUES (${table.columns.map(() => '?').join(', ')})`;
        for (const row of table.rows) {
          tx.run(insert, row.map(decode));
          rows += 1;
        }
      }
    });
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  const broken = db.all('PRAGMA foreign_key_check');
  if (broken.length > 0) {
    throw new BackupError(
      'verification_failed',
      `The restored rows break ${broken.length} foreign key(s). The backup is inconsistent.`,
    );
  }
  const reloaded: Record<string, BackupTable> = {};
  for (const name of included) {
    reloaded[name] = dumpTable(db, name);
  }
  if (digestOf(reloaded) !== backup.digest) {
    throw new BackupError(
      'verification_failed',
      'The restored rows do not match the backup',
    );
  }
  const migratedForward = applyMigrations(db, migrations);
  return { replayed, migratedForward, rows };
}

/**
 * A digest of the canonical state, for proving two stores hold the same thing. Tables and rows are
 * hashed in a fixed order, so it matches across a restart and across a restore.
 */
export function storeFingerprint(
  db: SqlDatabase,
  options: { includeTokenDigests?: boolean } = {},
): {
  digest: string;
  tables: Record<string, { rows: number; digest: string }>;
} {
  const tables: Record<string, BackupTable> = {};
  for (const name of selectedTables(db, options.includeTokenDigests === true)) {
    tables[name] = dumpTable(db, name);
  }
  return {
    digest: digestOf(tables),
    tables: Object.fromEntries(
      Object.entries(tables).map(([name, table]) => [
        name,
        { rows: table.rows.length, digest: digestOf({ [name]: table }) },
      ]),
    ),
  };
}
