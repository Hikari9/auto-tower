import type { SqlDatabase } from '../storage/database.js';

/**
 * A handle over an open transaction whose own `transaction` joins it. The event log opens a
 * write transaction per append, so without this a command could not make its events and
 * projection atomic with another module's writes.
 */
export function joinTransaction(tx: SqlDatabase): SqlDatabase {
  const joined: SqlDatabase = { ...tx, transaction: (fn) => fn(joined) };
  return joined;
}
