import { ValidationError } from '../core/errors.js';
import {
  LINK_CLASSIFICATIONS,
  type LinkClassification,
} from '../core/types.js';
import { InputReader, LIMITS } from '../core/validation.js';
import { SYNC_MODES, type SyncMode } from './types.js';

const id = { max: 128, min: 1 } as const;

export function parseAddLink(body: unknown): {
  expectedVersion: number;
  url: string;
  classification: LinkClassification;
  title: string | null;
} {
  const r = new InputReader(body);
  const parsed = {
    expectedVersion: r.integer('expectedVersion', {
      min: 1,
      max: 2_147_483_647,
    }),
    url: r.string('url', { max: 2_000, min: 1 }),
    classification: r.enum('classification', LINK_CLASSIFICATIONS),
    title: r.optNullableString('title', { max: LIMITS.title }) ?? null,
  };
  r.finish();
  return parsed;
}

export function parseCloseLinks(body: unknown): {
  urls: string[] | undefined;
  /** A person's choice to close although the provider could not say whether open issues block it. */
  overrideUnknownBlockers: boolean;
} {
  const r = new InputReader(body);
  const urls = r.optStrings('urls', {
    maxItems: LIMITS.links,
    maxLength: 2_000,
    minLength: 1,
  });
  const overrideUnknownBlockers = r.optBoolean('overrideUnknownBlockers');
  r.finish();
  return { urls, overrideUnknownBlockers: overrideUnknownBlockers === true };
}

export function parseReason(body: unknown): { reason: string } {
  const r = new InputReader(body);
  const reason = r.string('reason', { max: LIMITS.reason, min: 1 });
  r.finish();
  return { reason };
}

export function parseNote(body: unknown): { note: string } {
  const r = new InputReader(body);
  const note = r.string('note', { max: LIMITS.reason, min: 1 });
  r.finish();
  return { note };
}

export function parseEmpty(body: unknown): void {
  new InputReader(body).finish();
}

export function parseSyncConfig(body: unknown): {
  provider: string;
  repo: string;
  mode: SyncMode;
} {
  const r = new InputReader(body);
  const parsed = {
    provider: r.optString('provider', id) ?? 'github',
    repo: r.string('repo', id),
    mode: r.enum('mode', SYNC_MODES),
  };
  const readScope = r.optBoolean('readScope');
  const writeScope = r.optBoolean('writeScope');
  // The scopes follow from the mode. Naming them makes the intent explicit, and a mismatch is refused.
  const expectRead = parsed.mode !== 'link-only';
  const expectWrite = parsed.mode === 'bidirectional';
  if (readScope !== undefined && readScope !== expectRead) {
    r.fail('readScope', `must be ${expectRead} for mode ${parsed.mode}`);
  }
  if (writeScope !== undefined && writeScope !== expectWrite) {
    r.fail('writeScope', `must be ${expectWrite} for mode ${parsed.mode}`);
  }
  r.finish();
  return parsed;
}

export function parseDiscrepancyStatus(
  value: string | undefined,
): 'open' | 'resolved' | 'all' {
  if (value === undefined) {
    return 'open';
  }
  if (value === 'open' || value === 'resolved' || value === 'all') {
    return value;
  }
  throw new ValidationError([
    { path: 'status', message: 'must be open, resolved or all' },
  ]);
}
