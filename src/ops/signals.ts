/**
 * Health signals: what an operator must act on, each with a stable code, what happened and what to
 * do. They live in memory, keyed by database handle, because the failures they report are often a
 * database that will not take writes, which is the one place a signal cannot be stored.
 *
 * A signal is raised where a failure happens and cleared where the thing it reports works again.
 * Nothing here changes behavior: it only makes a failure visible instead of leaving it in a log.
 */
export type SignalSeverity = 'warning' | 'critical';

export interface HealthSignal {
  code: string;
  severity: SignalSeverity;
  message: string;
  /** What an operator should do about it. */
  action: string;
  since: string;
  lastAt: string;
  count: number;
}

export interface SignalInfo {
  severity: SignalSeverity;
  message: string;
  action: string;
}

export interface HealthSignals {
  raise(code: string, info: SignalInfo, at?: Date): void;
  clear(code: string): void;
  /** Active signals, oldest first. */
  active(): HealthSignal[];
  has(code: string): boolean;
}

export function createHealthSignals(): HealthSignals {
  const signals = new Map<string, HealthSignal>();
  return {
    raise(code, info, at = new Date()) {
      const stamp = at.toISOString();
      const existing = signals.get(code);
      signals.set(code, {
        code,
        ...info,
        since: existing?.since ?? stamp,
        lastAt: stamp,
        count: (existing?.count ?? 0) + 1,
      });
    },
    clear: (code) => {
      signals.delete(code);
    },
    active: () => [...signals.values()],
    has: (code) => signals.has(code),
  };
}

const registries = new WeakMap<object, HealthSignals>();

/** The signals for one database handle. Every module that holds the same handle shares them. */
export function signalsFor(db: object): HealthSignals {
  let found = registries.get(db);
  if (found === undefined) {
    found = createHealthSignals();
    registries.set(db, found);
  }
  return found;
}

/** Makes `wrapper` report to the same signals as `inner`, for a handle that wraps another. */
export function shareSignals(wrapper: object, inner: object): void {
  registries.set(wrapper, signalsFor(inner));
}

export const CLAIM_REFUSAL_WRITE_FAILED = 'fleet.claim_refusal_write_failed';
export const STORAGE_QUOTA_EXHAUSTED = 'storage.quota_exhausted';
