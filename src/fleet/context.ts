import type { Core } from '../core/index.js';
import type { SqlDatabase } from '../storage/database.js';
import type { FleetConfig } from './config.js';
import { FleetError } from './errors.js';
import { recordAudit } from './store.js';

export interface FleetContext {
  db: SqlDatabase;
  core: Core;
  config: FleetConfig;
  now: () => Date;
  ids: (prefix: string) => string;
  /**
   * One write transaction. A refusal that carries an audit entry is recorded in a second
   * transaction after the first rolls back, so the refusal is on record and nothing else is.
   */
  transact<T>(workspaceId: string, fn: (tx: SqlDatabase) => T): T;
}

export function createTransact(
  db: SqlDatabase,
  now: () => Date,
): FleetContext['transact'] {
  return (workspaceId, fn) => {
    try {
      return db.transaction(fn);
    } catch (error) {
      if (error instanceof FleetError && error.audit !== undefined) {
        const audit = error.audit;
        db.transaction((tx) =>
          recordAudit(tx, workspaceId, now().toISOString(), audit),
        );
      }
      throw error;
    }
  };
}

/** Runs `fn` so a failure undoes only its own writes, not the surrounding transaction. */
export function savepoint<T>(tx: SqlDatabase, fn: () => T): T {
  tx.exec('SAVEPOINT fleet_sp');
  try {
    const result = fn();
    tx.exec('RELEASE fleet_sp');
    return result;
  } catch (error) {
    tx.exec('ROLLBACK TO fleet_sp');
    tx.exec('RELEASE fleet_sp');
    throw error;
  }
}
