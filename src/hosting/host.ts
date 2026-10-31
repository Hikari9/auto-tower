import { createApp, ROUTES, resolveDependencies } from '../api/app.js';
import { dashboardRoutes } from '../api/routes/dashboard.js';
import { guardStorage } from '../ops/quota.js';
import { DEFAULT_SWEEP_INTERVAL_MS, startSweepInterval } from '../ops/sweep.js';
import { applyMigrations } from '../storage/migrate.js';
import {
  defaultMigrationsDir,
  readMigrationFiles,
} from '../storage/migration-files.js';
import { openSqliteDatabase } from '../storage/sqlite.js';
import { readHostConfig } from './config.js';
import { LOOPBACK_HOST, listenLoopback } from './listen.js';

const MIN_SWEEP_MS = 10;
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * `TOWER_SWEEP_INTERVAL_MS`: milliseconds between sweeps, `0` for none. An empty or unreadable
 * value is the default, so a typo never silently turns the sweep off.
 */
export function readSweepInterval(
  env: Readonly<Record<string, string | undefined>>,
): number {
  // Trimmed first: Number(' ') is 0, and a blank value must not turn the sweep off.
  const raw = env.TOWER_SWEEP_INTERVAL_MS?.trim();
  if (raw === undefined || raw === '') {
    return DEFAULT_SWEEP_INTERVAL_MS;
  }
  const ms = Number(raw);
  // Node clamps a timer above 2^31-1 ms to 1 ms, so a "long" interval would become a busy loop, and
  // under 10 ms a synchronous sweep would starve the event loop. Both fall back to the default.
  const ok =
    Number.isInteger(ms) &&
    (ms === 0 || (ms >= MIN_SWEEP_MS && ms <= MAX_TIMER_MS));
  return ok ? ms : DEFAULT_SWEEP_INTERVAL_MS;
}

/**
 * Opens and migrates the database, then serves the app on loopback. The database is behind the
 * quota guard, so a full disk fails writes closed instead of half-working. A sweep ticks every
 * workspace on an interval, so ready work dispatches and leases recover with no runner poll.
 */
export function startHost(
  env: Readonly<Record<string, string | undefined>>,
  log: (line: string) => void = console.log,
) {
  const { dbPath, port } = readHostConfig(env);
  const db = guardStorage(openSqliteDatabase(dbPath));
  const applied = applyMigrations(
    db,
    readMigrationFiles(defaultMigrationsDir()),
  );
  // Resolved here so the sweep and the routes share one core and one fleet.
  const resolved = resolveDependencies({ db });
  const app = createApp(resolved, [...ROUTES, ...dashboardRoutes]);
  const sweepMs = readSweepInterval(env);
  const sweep =
    sweepMs > 0 ? startSweepInterval(db, resolved.fleet, sweepMs) : undefined;
  const server = listenLoopback(app.fetch, port, (info) => {
    log(
      `Tower listening on http://${LOOPBACK_HOST}:${info.port} (db ${dbPath}, migrations applied now: ${applied.length}, sweep ${sweepMs > 0 ? `every ${sweepMs} ms` : 'off'})`,
    );
  });
  server.once('close', () => sweep?.stop());
  return server;
}
