import { ValidationError } from '../core/errors.js';
import { InputReader } from '../core/validation.js';

export const ID = { max: 128, min: 1 } as const;

/** Splits off one string id and returns the arguments that remain, for a parser that takes the rest. */
export function takeId(
  args: Record<string, unknown>,
  key: string,
): { id: string; rest: Record<string, unknown> } {
  const { [key]: value, ...rest } = args;
  const r = new InputReader({ [key]: value });
  const id = r.string(key, ID);
  r.finish();
  return { id, rest };
}

/**
 * Search and list arguments arrive as JSON values. The core's query parser takes strings, as a URL
 * does, so arrays join with commas and numbers print. Anything nested is refused, not coerced.
 */
export function asQuery(args: Record<string, unknown>): Record<string, string> {
  const query: Record<string, string> = {};
  const issues: Array<{ path: string; message: string }> = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === 'string') {
      query[key] = value;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      query[key] = String(value);
    } else if (
      Array.isArray(value) &&
      value.every((item) => typeof item === 'string' && !item.includes(','))
    ) {
      query[key] = value.join(',');
    } else {
      issues.push({
        path: key,
        message: 'must be a string, number or list of strings',
      });
    }
  }
  if (issues.length > 0) {
    throw new ValidationError(issues);
  }
  return query;
}

export function readerOf(args: Record<string, unknown>): InputReader {
  return new InputReader(args);
}
