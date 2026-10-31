import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Migration } from './migrate.js';

const MIGRATION_FILE = /^\d{4}_[\w-]+\.sql$/;

/** The repo's `migrations/` directory, resolved from this module (Node host only). */
export function defaultMigrationsDir(): string {
  return fileURLToPath(new URL('../../migrations', import.meta.url));
}

/** Reads `NNNN_name.sql` files from a directory in filename order (Node host only). */
export function readMigrationFiles(dir: string): Migration[] {
  return readdirSync(dir)
    .filter((name) => MIGRATION_FILE.test(name))
    .sort()
    .map((name) => ({
      id: name.replace(/\.sql$/, ''),
      sql: readFileSync(join(dir, name), 'utf8'),
    }));
}
