export interface BackoffPolicy {
  baseMs: number;
  capMs: number;
}

/** Exponential delay after `failures` consecutive failures, never above the cap. */
export function backoffMs(failures: number, policy: BackoffPolicy): number {
  if (!Number.isFinite(failures) || failures <= 0) {
    return 0;
  }
  // Clamp the exponent first so a huge failure count cannot overflow to Infinity.
  const exponent = Math.min(Math.floor(failures) - 1, 30);
  return Math.min(policy.baseMs * 2 ** exponent, policy.capMs);
}
