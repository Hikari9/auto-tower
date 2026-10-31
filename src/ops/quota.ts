import type { SqlDatabase } from '../storage/database.js';
import {
  STORAGE_QUOTA_EXHAUSTED,
  shareSignals,
  signalsFor,
} from './signals.js';

/**
 * Storage quota exhaustion fails closed. A write the store refuses for space or plan limits trips
 * the guard: from then on every mutation is refused at once, with an error that says what to do,
 * and a health signal stays up until an operator clears it. Reads keep working, so state can still
 * be inspected and backed up while the store cannot take writes.
 *
 * Nothing that needs a write can proceed, which is what makes it safe: a guarded effect records its
 * intent before it acts (an outbound issue close writes its marker first), a claim writes its lease,
 * and a mission moves by appending an event. A store that cannot take those writes cannot be told
 * that work happened, so the work does not start.
 */
export class StorageQuotaError extends Error {
  override readonly name = 'StorageQuotaError';
  readonly code = 'storage_quota_exhausted';
  constructor(
    message = 'The store is out of space or over its write quota. Writes are refused until an operator clears it.',
  ) {
    super(message);
  }
}

/** What SQLite and D1 say when a write is refused for space or plan limits. */
const QUOTA_MESSAGE =
  /database or disk is full|SQLITE_FULL|exceeded.{0,40}(quota|limit)|(quota|storage|database size|row).{0,40}(exceeded|limit reached)|D1_.{0,40}(LIMIT|QUOTA)/i;

export function isQuotaFailure(error: unknown): boolean {
  if (error instanceof StorageQuotaError) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as { code?: unknown }).code;
  return (
    (typeof code === 'string' &&
      /SQLITE_FULL|D1_.*(LIMIT|QUOTA)/i.test(code)) ||
    QUOTA_MESSAGE.test(error.message)
  );
}

const MUTATING =
  /^\s*(insert|update|delete|replace|create|alter|drop|vacuum|pragma\s+\w+\s*=)/i;

export interface QuotaGuard {
  readonly tripped: boolean;
  /** Clears the guard once the operator has freed space or raised the limit. Writes are tried again. */
  reset(): void;
}

export type GuardedDatabase = SqlDatabase & { readonly quota: QuotaGuard };

const ACTION =
  'Free storage or raise the plan limit, take a backup (reads still work), then clear the guard with `pnpm ops quota-reset` or the ops_quota_reset action.';

/** Wraps a database so an exhausted quota refuses every mutation until cleared. Shares the inner handle's health signals. */
export function guardStorage(
  inner: SqlDatabase,
  options: { now?: () => Date } = {},
): GuardedDatabase {
  const now = options.now ?? (() => new Date());
  let tripped = false;

  const guard: QuotaGuard = {
    get tripped() {
      return tripped;
    },
    reset() {
      tripped = false;
      signalsFor(inner).clear(STORAGE_QUOTA_EXHAUSTED);
    },
  };

  function trip(): never {
    tripped = true;
    signalsFor(inner).raise(
      STORAGE_QUOTA_EXHAUSTED,
      {
        severity: 'critical',
        message:
          'The store refused a write because it is out of space or over its quota. Every mutation is refused, so no new work starts and nothing is falsely reported as done.',
        action: ACTION,
      },
      now(),
    );
    throw new StorageQuotaError();
  }

  function refuseIfTripped(): void {
    if (tripped) {
      throw new StorageQuotaError();
    }
  }

  function attempt<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      if (isQuotaFailure(error)) {
        return trip();
      }
      throw error;
    }
  }

  const guarded: GuardedDatabase = {
    quota: guard,
    exec(sql) {
      if (MUTATING.test(sql) || /^\s*begin/i.test(sql)) {
        refuseIfTripped();
      }
      attempt(() => inner.exec(sql));
    },
    run(sql, params) {
      refuseIfTripped();
      return attempt(() => inner.run(sql, params));
    },
    get: (sql, params) => inner.get(sql, params),
    all: (sql, params) => inner.all(sql, params),
    transaction<T>(fn: (tx: SqlDatabase) => T): T {
      refuseIfTripped();
      return attempt(() => inner.transaction((tx) => fn(wrapTx(tx))));
    },
    close: () => inner.close(),
  };

  // Statements inside a transaction go through the same check, so a refused write rolls the
  // transaction back as a whole.
  function wrapTx(tx: SqlDatabase): SqlDatabase {
    if (tx !== inner) {
      return tx;
    }
    return guarded;
  }

  shareSignals(guarded, inner);
  return guarded;
}

export { MUTATING as isMutatingSql };
