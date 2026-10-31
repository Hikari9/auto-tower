/**
 * One claiming process for the double-claim test. It opens its own connection to the database
 * file, builds its own core and fleet, tells the parent it is ready, waits for the go signal, and
 * claims once. Two of these run at the same time in separate processes.
 */
import { createCore } from '../../src/core/index.js';
import {
  createFleet,
  createPool,
  defaultFleetConfig,
} from '../../src/fleet/index.js';
import { openSqliteDatabase } from '../../src/storage/sqlite.js';

interface Job {
  dbPath: string;
  nowMs: number;
  workspaceId: string;
  caller: { workspaceId: string; principalId: string; tokenId: string };
  version: string;
  buildDigest: string;
}

process.on('message', (job: Job | 'go') => {
  if (job === 'go') {
    return;
  }
  const db = openSqliteDatabase(job.dbPath);
  const now = () => new Date(job.nowMs);
  const config = {
    ...defaultFleetConfig(),
    supportedVersions: () => ({ min: '1.0.0', max: '1.9.9' }),
  };
  const core = createCore({
    db,
    clock: now,
    pool: createPool({ db, now, config }),
  });
  const fleet = createFleet({ db, core, now, config });
  process.send?.('ready');
  process.once('message', (signal) => {
    if (signal !== 'go') {
      return;
    }
    try {
      const result = fleet.claim(job.caller, {
        version: job.version,
        buildDigest: job.buildDigest,
        capabilities: undefined,
        active: [],
      });
      process.send?.({
        ok: true,
        assignments: result.assignments.map((a) => a.leaseId),
        withheld: result.withheld.map((w) => w.reason),
      });
    } catch (error) {
      process.send?.({
        ok: false,
        name: error instanceof Error ? error.name : 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      db.close();
      process.exit(0);
    }
  });
});
