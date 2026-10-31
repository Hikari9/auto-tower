import type { Context } from 'hono';
import { Hono } from 'hono';
import {
  type AuthVariables,
  authenticate,
  requireScopes,
} from '../auth/middleware.js';
import type { Scope } from '../auth/principals.js';
import type { SqlDatabase } from '../storage/database.js';
import { errorBody, handleError } from './errors.js';
import { healthRoute } from './routes/health.js';

export type AppEnv = { Variables: AuthVariables };

/** A route is either public or names at least one scope. Nothing is open by default. */
export type RouteAccess =
  | { public: true }
  | { scopes: readonly [Scope, ...Scope[]] };

export interface RouteSpec {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  path: string;
  access: RouteAccess;
  handler: (c: Context<AppEnv>) => Response | Promise<Response>;
}

export const ROUTES: readonly RouteSpec[] = [healthRoute];

export interface AppDependencies {
  db: SqlDatabase;
  now?: () => Date;
}

export function createApp(
  deps: AppDependencies,
  routes: readonly RouteSpec[] = ROUTES,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.onError(handleError);
  app.notFound((c) => c.json(errorBody('not_found', 'Route not found'), 404));

  for (const route of routes) {
    const method = route.method.toUpperCase();
    if ('public' in route.access && route.access.public === true) {
      app.on(method, route.path, route.handler);
    } else {
      const scopes = assertScopes(route);
      app.on(
        method,
        route.path,
        authenticate(deps.db, deps.now),
        requireScopes(scopes),
        route.handler,
      );
    }
  }
  return app;
}

function assertScopes(route: RouteSpec): readonly Scope[] {
  if (!('scopes' in route.access) || route.access.scopes.length === 0) {
    throw new Error(
      `Route ${route.method.toUpperCase()} ${route.path} declares no access`,
    );
  }
  return route.access.scopes;
}
