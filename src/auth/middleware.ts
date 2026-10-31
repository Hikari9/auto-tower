import { createMiddleware } from 'hono/factory';
import { errorBody } from '../api/errors.js';
import type { SqlDatabase } from '../storage/database.js';
import type { Scope } from './principals.js';
import { type AuthenticatedToken, authenticateToken } from './tokens.js';

export interface AuthVariables {
  auth: AuthenticatedToken;
}

const BEARER = /^Bearer\s+(\S+)$/i;

/** Rejects requests without a valid bearer token with 401. */
export function authenticate(
  db: SqlDatabase,
  now: () => Date = () => new Date(),
) {
  return createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
    const raw = BEARER.exec(c.req.header('authorization') ?? '')?.[1];
    const auth =
      raw === undefined ? undefined : authenticateToken(db, raw, now());
    if (auth === undefined) {
      return c.json(
        errorBody('unauthenticated', 'A valid bearer token is required'),
        401,
        {
          'WWW-Authenticate': 'Bearer',
        },
      );
    }
    c.set('auth', auth);
    await next();
  });
}

/** Rejects authenticated requests that lack any required scope with 403. */
export function requireScopes(required: readonly Scope[]) {
  return createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
    const { scopes } = c.get('auth');
    if (!required.every((scope) => scopes.includes(scope))) {
      return c.json(
        errorBody('forbidden', 'The token lacks a scope this route requires'),
        403,
      );
    }
    await next();
  });
}
