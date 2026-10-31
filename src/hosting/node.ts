import { createApp } from '../api/app.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  defaultMigrationsDir,
  readMigrationFiles,
} from '../storage/migration-files.js';
import { openSqliteDatabase } from '../storage/sqlite.js';
import { readHostConfig } from './config.js';
import { LOOPBACK_HOST, listenLoopback } from './listen.js';

const { dbPath, port } = readHostConfig(process.env);
const db = openSqliteDatabase(dbPath);
const applied = applyMigrations(db, readMigrationFiles(defaultMigrationsDir()));
const app = createApp({ db });

listenLoopback(app.fetch, port, (info) => {
  console.log(
    `Tower listening on http://${LOOPBACK_HOST}:${info.port} (db ${dbPath}, migrations applied now: ${applied.length})`,
  );
});
