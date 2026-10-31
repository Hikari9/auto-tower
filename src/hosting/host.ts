import { createApp } from '../api/app.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  defaultMigrationsDir,
  readMigrationFiles,
} from '../storage/migration-files.js';
import { openSqliteDatabase } from '../storage/sqlite.js';
import { readHostConfig } from './config.js';
import { LOOPBACK_HOST, listenLoopback } from './listen.js';

/** Opens and migrates the database, then serves the app on loopback. */
export function startHost(
  env: Readonly<Record<string, string | undefined>>,
  log: (line: string) => void = console.log,
) {
  const { dbPath, port } = readHostConfig(env);
  const db = openSqliteDatabase(dbPath);
  const applied = applyMigrations(
    db,
    readMigrationFiles(defaultMigrationsDir()),
  );
  const app = createApp({ db });
  return listenLoopback(app.fetch, port, (info) => {
    log(
      `Tower listening on http://${LOOPBACK_HOST}:${info.port} (db ${dbPath}, migrations applied now: ${applied.length})`,
    );
  });
}
