/** Client versions are plain `major.minor.patch`. No pre-release or build suffix, so ordering is unambiguous. */
const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export interface VersionRange {
  /** Inclusive. */
  min: string;
  /** Inclusive. */
  max: string;
}

export function isVersion(value: string): boolean {
  return VERSION.test(value);
}

export function isDigest(value: string): boolean {
  return DIGEST.test(value);
}

function parts(version: string): [number, number, number] | undefined {
  const match = VERSION.exec(version);
  return match === null
    ? undefined
    : [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Negative, zero or positive. Undefined when either side is not a valid version. */
export function compareVersions(a: string, b: string): number | undefined {
  const left = parts(a);
  const right = parts(b);
  if (left === undefined || right === undefined) {
    return undefined;
  }
  for (let i = 0; i < 3; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

/** Fails closed: an invalid version, or an invalid range, is never supported. */
export function inSupportedRange(
  version: string,
  range: VersionRange,
): boolean {
  const low = compareVersions(version, range.min);
  const high = compareVersions(version, range.max);
  return low !== undefined && high !== undefined && low >= 0 && high <= 0;
}
