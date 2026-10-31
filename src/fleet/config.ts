import type { BackoffPolicy } from './backoff.js';
import type { VersionRange } from './version.js';

export interface FleetConfig {
  /** Read on every claim, so narrowing it takes effect on the next poll. */
  supportedVersions: () => VersionRange;
  /** Suggested delay between polls. */
  pollIntervalMs: number;
  /** How long a lease lives without matching work evidence. */
  leaseTtlMs: number;
  /** How long a lease may sit in recovery before another runner may take it. */
  reassignGraceMs: number;
  /** A runner not heard from within this window is not offered new work. */
  livenessWindowMs: number;
  enrollmentTtlMs: { default: number; max: number };
  backoff: BackoffPolicy;
}

export const DEFAULT_SUPPORTED_VERSIONS: VersionRange = {
  min: '1.0.0',
  max: '1.99.99',
};

export function defaultFleetConfig(): FleetConfig {
  return {
    supportedVersions: () => DEFAULT_SUPPORTED_VERSIONS,
    pollIntervalMs: 5_000,
    leaseTtlMs: 60_000,
    reassignGraceMs: 120_000,
    livenessWindowMs: 180_000,
    enrollmentTtlMs: { default: 15 * 60_000, max: 24 * 60 * 60_000 },
    backoff: { baseMs: 1_000, capMs: 60_000 },
  };
}
