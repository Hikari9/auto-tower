import { parsePublicHttpsUrl } from '../issues/url.js';
import { ValidationError, type ValidationIssue } from './errors.js';
import {
  type DoneItem,
  type IssueLinkRef,
  LINK_CLASSIFICATIONS,
} from './types.js';

export const LIMITS = {
  title: 200,
  text: 10_000,
  listItem: 500,
  listItems: 100,
  scopeItems: 50,
  refs: 32,
  ref: 512,
  links: 50,
  packets: 200,
  dependsOn: 50,
  source: 64,
  reason: 1_000,
} as const;

interface StringOptions {
  max: number;
  min?: number;
}

/**
 * Reads a JSON object field by field and collects every problem, so a caller
 * sees all of them at once. Unknown keys are an error, which catches typos.
 */
export class InputReader {
  private readonly issues: ValidationIssue[] = [];
  private readonly seen = new Set<string>();
  private readonly data: Record<string, unknown>;

  constructor(
    value: unknown,
    private readonly path = '',
  ) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      this.data = value as Record<string, unknown>;
    } else {
      this.data = {};
      this.issues.push({ path, message: 'must be a JSON object' });
    }
  }

  has(key: string): boolean {
    return this.data[key] !== undefined;
  }

  fail(key: string, message: string): void {
    this.issues.push({
      path: this.path ? `${this.path}.${key}` : key,
      message,
    });
  }

  private take(key: string): unknown {
    this.seen.add(key);
    return this.data[key];
  }

  string(key: string, options: StringOptions): string {
    const value = this.take(key);
    if (value === undefined) {
      this.fail(key, 'is required');
      return '';
    }
    return this.checkString(key, value, options) ?? '';
  }

  optString(key: string, options: StringOptions): string | undefined {
    const value = this.take(key);
    return value === undefined
      ? undefined
      : this.checkString(key, value, options);
  }

  /** A string or null. Absent keys read as undefined. */
  optNullableString(
    key: string,
    options: StringOptions,
  ): string | null | undefined {
    const value = this.take(key);
    if (value === undefined || value === null) {
      return value;
    }
    return this.checkString(key, value, options);
  }

  private checkString(
    key: string,
    value: unknown,
    { max, min = 0 }: StringOptions,
  ): string | undefined {
    if (typeof value !== 'string') {
      this.fail(key, 'must be a string');
      return undefined;
    }
    // Compare the trimmed length so whitespace cannot satisfy a minimum.
    if (value.trim().length < min) {
      this.fail(
        key,
        min === 1 ? 'must not be empty' : `needs ${min}+ characters`,
      );
      return undefined;
    }
    if (value.length > max) {
      this.fail(key, `must be at most ${max} characters`);
      return undefined;
    }
    return value;
  }

  optEnum<T extends string>(key: string, values: readonly T[]): T | undefined {
    const value = this.take(key);
    if (value === undefined) {
      return undefined;
    }
    if (
      typeof value === 'string' &&
      (values as readonly string[]).includes(value)
    ) {
      return value as T;
    }
    this.fail(key, `must be one of ${values.join(', ')}`);
    return undefined;
  }

  enum<T extends string>(key: string, values: readonly T[]): T {
    const value = this.optEnum(key, values);
    if (value === undefined && !this.issues.some((i) => i.path.endsWith(key))) {
      this.fail(key, 'is required');
    }
    return value ?? values[0] ?? ('' as T);
  }

  optBoolean(key: string): boolean | undefined {
    const value = this.take(key);
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== 'boolean') {
      this.fail(key, 'must be a boolean');
      return undefined;
    }
    return value;
  }

  optInteger(
    key: string,
    { min, max }: { min: number; max: number },
  ): number | undefined {
    const value = this.take(key);
    if (value === undefined) {
      return undefined;
    }
    if (
      !Number.isInteger(value) ||
      (value as number) < min ||
      (value as number) > max
    ) {
      this.fail(key, `must be an integer from ${min} to ${max}`);
      return undefined;
    }
    return value as number;
  }

  integer(key: string, range: { min: number; max: number }): number {
    const value = this.optInteger(key, range);
    if (value === undefined && !this.issues.some((i) => i.path.endsWith(key))) {
      this.fail(key, 'is required');
    }
    return value ?? range.min;
  }

  optStrings(
    key: string,
    { maxItems, maxLength, minLength = 0 }: StringsOptions,
  ): string[] | undefined {
    const value = this.take(key);
    if (value === undefined) {
      return undefined;
    }
    if (!Array.isArray(value)) {
      this.fail(key, 'must be an array of strings');
      return undefined;
    }
    if (value.length > maxItems) {
      this.fail(key, `must have at most ${maxItems} items`);
      return undefined;
    }
    const out: string[] = [];
    value.forEach((item: unknown, index) => {
      if (typeof item !== 'string' || item.trim().length < minLength) {
        this.fail(`${key}[${index}]`, 'must be a non-empty string');
      } else if (item.length > maxLength) {
        this.fail(
          `${key}[${index}]`,
          `must be at most ${maxLength} characters`,
        );
      } else {
        out.push(item);
      }
    });
    return out;
  }

  /** Reads an array of objects, giving each its own reader for field-level errors. */
  optItems<T>(
    key: string,
    maxItems: number,
    read: (item: InputReader) => T,
  ): T[] | undefined {
    const value = this.take(key);
    if (value === undefined) {
      return undefined;
    }
    if (!Array.isArray(value)) {
      this.fail(key, 'must be an array');
      return undefined;
    }
    if (value.length > maxItems) {
      this.fail(key, `must have at most ${maxItems} items`);
      return undefined;
    }
    return value.map((item: unknown, index) => {
      const child = new InputReader(
        item,
        this.path ? `${this.path}.${key}[${index}]` : `${key}[${index}]`,
      );
      const result = read(child);
      this.issues.push(...child.finishIssues());
      return result;
    });
  }

  /** Throws when anything was wrong, including unknown keys. */
  finish(): void {
    const issues = this.finishIssues();
    if (issues.length > 0) {
      throw new ValidationError(issues);
    }
  }

  finishIssues(): ValidationIssue[] {
    const unknown = Object.keys(this.data)
      .filter((key) => !this.seen.has(key))
      .map((key) => ({
        path: this.path ? `${this.path}.${key}` : key,
        message: 'is not a recognised field',
      }));
    return [...this.issues, ...unknown];
  }
}

interface StringsOptions {
  maxItems: number;
  maxLength: number;
  minLength?: number;
}

/** Reference lists (evidence, policy): short opaque strings, bounded in count. */
export function readRefs(reader: InputReader, key: string): string[] {
  return (
    reader.optStrings(key, {
      maxItems: LIMITS.refs,
      maxLength: LIMITS.ref,
      minLength: 1,
    }) ?? []
  );
}

function readDoneItem(item: InputReader): DoneItem {
  const text = item.string('text', { max: LIMITS.listItem, min: 1 });
  const done = item.optBoolean('done') ?? false;
  return { text, done };
}

function readLink(item: InputReader): IssueLinkRef {
  const url = item.string('url', { max: 2_000, min: 1 });
  const classification = item.enum('classification', LINK_CLASSIFICATIONS);
  const title = item.optNullableString('title', { max: LIMITS.title }) ?? null;
  return { url: normalizeLinkUrl(item, url), classification, title };
}

/**
 * Links are public https URLs: the same check `addLink` applies. That rules out `file:`,
 * `javascript:` and plain http, credentials, IP literals (loopback, private, link-local and
 * metadata hosts) and internal names. The fragment is dropped.
 */
function normalizeLinkUrl(item: InputReader, raw: string): string {
  const parsed = parsePublicHttpsUrl(raw);
  if (!parsed.ok) {
    item.fail('url', parsed.message);
    return raw;
  }
  return parsed.url.href;
}

export function readLinks(
  reader: InputReader,
  key: string,
): IssueLinkRef[] | undefined {
  const links = reader.optItems(key, LIMITS.links, readLink);
  if (links !== undefined) {
    const urls = new Set<string>();
    for (const link of links) {
      if (urls.has(link.url)) {
        reader.fail(key, `lists ${link.url} more than once`);
      }
      urls.add(link.url);
    }
  }
  return links;
}

export function readDefinitionOfDone(
  reader: InputReader,
  key: string,
): DoneItem[] | undefined {
  return reader.optItems(key, LIMITS.listItems, readDoneItem);
}

export function readConstraints(
  reader: InputReader,
  key: string,
): string[] | undefined {
  return reader.optStrings(key, {
    maxItems: LIMITS.listItems,
    maxLength: LIMITS.listItem,
    minLength: 1,
  });
}
