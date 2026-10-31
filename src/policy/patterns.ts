/**
 * Patterns are plain strings where `*` matches any run of characters, including none. There is
 * no other syntax, so a pattern can never be a regular expression or escape its string.
 */
export const MAX_PATTERN_LENGTH = 256;
export const MAX_WILDCARDS = 8;

/**
 * Matches without backtracking into a regular expression engine. The cost is bounded by
 * the product of the two lengths, which the length limits keep small.
 */
export function matchesPattern(pattern: string, value: string): boolean {
  let p = 0;
  let v = 0;
  let star = -1;
  let resume = 0;
  while (v < value.length) {
    if (p < pattern.length && pattern[p] === '*') {
      star = p;
      resume = v;
      p += 1;
    } else if (p < pattern.length && pattern[p] === value[v]) {
      p += 1;
      v += 1;
    } else if (star >= 0) {
      resume += 1;
      v = resume;
      p = star + 1;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') {
    p += 1;
  }
  return p === pattern.length;
}

/**
 * True when some string is matched by both patterns. Used where a request is itself a pattern, such
 * as a cited rule's own action, so a deny rule for one member of it still counts. Cost is bounded by
 * the product of the two lengths.
 */
export function patternsOverlap(a: string, b: string): boolean {
  const seen = new Map<number, boolean>();
  const walk = (i: number, j: number): boolean => {
    if (i === a.length && j === b.length) {
      return true;
    }
    const key = i * (b.length + 1) + j;
    const known = seen.get(key);
    if (known !== undefined) {
      return known;
    }
    const aStar = a[i] === '*';
    const bStar = b[j] === '*';
    let result = false;
    if (aStar && walk(i + 1, j)) {
      result = true;
    } else if (bStar && walk(i, j + 1)) {
      result = true;
    } else if (aStar && j < b.length && walk(i, j + 1)) {
      result = true;
    } else if (bStar && i < a.length && walk(i + 1, j)) {
      result = true;
    } else if (!aStar && !bStar && i < a.length && j < b.length) {
      result = a[i] === b[j] && walk(i + 1, j + 1);
    }
    seen.set(key, result);
    return result;
  };
  return walk(0, 0);
}

export function hasWildcard(pattern: string): boolean {
  return pattern.includes('*');
}

/**
 * True when every string `candidate` matches is also matched by `original`. The candidate is
 * checked as a literal: `original` has no literal `*`, so each `*` in the candidate can only be
 * absorbed by a wildcard of `original`, which would absorb any replacement just as well.
 * Conservative: some genuine narrowings are refused, no widening is accepted.
 */
export function isNarrowerPattern(
  candidate: string,
  original: string,
): boolean {
  return candidate === original || matchesPattern(original, candidate);
}

/**
 * `*` matches `/` and `..` like any other text, so a path that climbs out of a subtree has to be
 * refused before it is matched against a pattern.
 */
export function hasTraversal(value: string): boolean {
  return value.split(/[\\/]/).some((segment) => segment === '..');
}
