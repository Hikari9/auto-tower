import type { Fleet } from '../fleet/index.js';
import type { SqlDatabase } from '../storage/database.js';
import { signalsFor } from './signals.js';

export const SWEEP_FAILED = 'ops.sweep_failed';

/** How often the Node server sweeps. Short enough that a ready mission never waits long for a poll. */
export const DEFAULT_SWEEP_INTERVAL_MS = 15_000;

export interface SweepResult {
  workspaces: number;
  failed: string[];
}

/**
 * Sweeps every workspace: lease expiry and recovery, then the scheduler, so authorized work is
 * dispatched with no runner polling. One workspace failing does not stop the others. A failure is
 * a health signal until the next clean sweep, not just a log line.
 */
export function runSweep(
  db: SqlDatabase,
  fleet: Pick<Fleet, 'tick'>,
): SweepResult {
  const ids = db
    .all<{ id: string }>('SELECT id FROM workspaces ORDER BY id')
    .map((row) => row.id);
  const failed: string[] = [];
  for (const id of ids) {
    try {
      fleet.tick(id);
    } catch (error) {
      failed.push(id);
      console.error(
        `sweep failed for a workspace: ${error instanceof Error ? error.name : 'error'}`,
      );
    }
  }
  const signals = signalsFor(db);
  if (failed.length > 0) {
    signals.raise(SWEEP_FAILED, {
      severity: 'warning',
      message: `The scheduled sweep failed for ${failed.length} workspace(s). Leases may not expire and ready work may wait for a runner poll.`,
      action:
        'Check the server log for the error name and the database health.',
    });
  } else {
    signals.clear(SWEEP_FAILED);
  }
  return { workspaces: ids.length, failed };
}

export interface SweepHandle {
  stop(): void;
}

/**
 * Runs the sweep on an interval. The timer does not keep the process alive. A sweep that is still
 * running when the next tick fires is skipped rather than stacked.
 */
export function startSweepInterval(
  db: SqlDatabase,
  fleet: Pick<Fleet, 'tick'>,
  intervalMs: number = DEFAULT_SWEEP_INTERVAL_MS,
): SweepHandle {
  let running = false;
  const timer = setInterval(() => {
    if (running) {
      return;
    }
    running = true;
    try {
      runSweep(db, fleet);
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer) };
}
