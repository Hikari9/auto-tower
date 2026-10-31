import type { SqlDatabase } from '../storage/database.js';
import { type HaltState, haltState } from './halt.js';
import { type HealthSignal, signalsFor } from './signals.js';

export interface HealthReport {
  /** `halted` outranks `degraded`: a halted workspace is stopped on purpose. */
  status: 'ok' | 'degraded' | 'critical' | 'halted';
  halt: HaltState;
  signals: HealthSignal[];
  /** The database answered a read. False means everything else here is unreliable. */
  storageReadable: boolean;
}

/** What an operator should look at first. Reads only. */
export function healthReport(
  db: SqlDatabase,
  workspaceId: string,
): HealthReport {
  let storageReadable = true;
  let halt: HaltState = {
    halted: false,
    reason: null,
    changedBy: null,
    changedAt: null,
  };
  try {
    db.get('SELECT 1 AS one');
    halt = haltState(db, workspaceId);
  } catch {
    storageReadable = false;
  }
  const signals = signalsFor(db).active();
  const status = halt.halted
    ? 'halted'
    : !storageReadable || signals.some((s) => s.severity === 'critical')
      ? 'critical'
      : signals.length > 0
        ? 'degraded'
        : 'ok';
  return { status, halt, signals, storageReadable };
}
