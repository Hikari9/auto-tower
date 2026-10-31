import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from '../api/app.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  defaultMigrationsDir,
  readMigrationFiles,
} from '../storage/migration-files.js';
import { openSqliteDatabase } from '../storage/sqlite.js';

const dbPath = process.env.TOWER_DB_PATH ?? '.tower/tower.sqlite';
const port = Number(process.env.PORT ?? 8787);

if (dbPath !== ':memory:') {
  mkdirSync(dirname(dbPath), { recursive: true });
}
const db = openSqliteDatabase(dbPath);
const applied = applyMigrations(db, readMigrationFiles(defaultMigrationsDir()));
const app = createApp({ db });

// Bound to loopback so a dev server is never reachable from the LAN by accident.
serve({ fetch: app.fetch, hostname: '127.0.0.1', port }, (info) => {
  console.log(
    `Tower listening on http://127.0.0.1:${info.port} (db ${dbPath}, migrations applied now: ${applied.length})`,
  );
});
