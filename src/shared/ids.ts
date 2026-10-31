import { randomUUID } from 'node:crypto';

/** Opaque, prefixed identifier such as `prn_3f2a…`. */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}
