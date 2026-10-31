import type { Context } from 'hono';
import {
  IdempotencyKeyReuseError,
  VersionConflictError,
} from '../events/errors.js';

export function errorBody(
  code: string,
  message: string,
): { error: { code: string; message: string } } {
  return { error: { code, message } };
}

/** Maps domain and API errors to HTTP responses. Unknown errors never expose details. */
export function handleError(error: Error, c: Context): Response {
  if (error instanceof VersionConflictError) {
    return c.json(errorBody('version_conflict', error.message), 409);
  }
  if (error instanceof IdempotencyKeyReuseError) {
    return c.json(errorBody('idempotency_key_reused', error.message), 409);
  }
  console.error('unhandled error', error.name);
  return c.json(errorBody('internal_error', 'Internal server error'), 500);
}
