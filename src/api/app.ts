import type { Context } from 'hono';
import { Hono } from 'hono';
import {
  type AuthVariables,
  authenticate,
  requireScopes,
} from '../auth/middleware.js';
import type { Scope } from '../auth/principals.js';
import { type Core, createCore } from '../core/index.js';
import type { Authority } from '../decisions/index.js';
import {
  createFleet,
  createPool,
  type Fleet,
  type FleetConfig,
} from '../fleet/index.js';
import type { SqlDatabase } from '../storage/database.js';
import { errorBody, handleError } from './errors.js';
import { decisionRoutes } from './routes/decisions.js';
import { healthRoute } from './routes/health.js';
import { missionRoutes } from './routes/missions.js';
import { policyRoutes } from './routes/policy.js';
import { runnerRoutes } from './routes/runners.js';
import { workRoutes } from './routes/work.js';

export type AppEnv = {
  Variables: AuthVariables & { deps: AppDependencies };
};

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

export const ROUTES: readonly RouteSpec[] = [
  healthRoute,
  ...missionRoutes,
  ...workRoutes,
  ...policyRoutes,
  ...decisionRoutes,
  ...runnerRoutes,
];

export interface AppDependencies {
  db: SqlDatabase;
  now?: () => Date;
  /** Mission core. Built over `db` when absent. Tests and hosts inject one to control the runner pool and clock. */
  core?: Core;
  /** Policy store, Decision Inbox and tier routing. Built over `db` and the core's guards when absent. */
  authority?: Authority;
  /** Runner enrollment, leases and fencing. Built over `db` and the core when absent. */
  fleet?: Fleet;
  /** Supported client range, lease timing and backoff. Used only when the app builds the fleet. */
  fleetConfig?: FleetConfig;
}

export function createApp(
  deps: AppDependencies,
  routes: readonly RouteSpec[] = ROUTES,
): Hono<AppEnv> {
  // The fleet's broker is the scheduler's runner pool, so a core built here dispatches to real runners.
  const core =
    deps.core ??
    createCore({
      db: deps.db,
      ...(deps.now === undefined ? {} : { clock: deps.now }),
      pool: createPool({
        db: deps.db,
        ...(deps.now === undefined ? {} : { now: deps.now }),
        ...(deps.fleetConfig === undefined ? {} : { config: deps.fleetConfig }),
      }),
    });
  const resolved: AppDependencies = {
    ...deps,
    core,
    fleet:
      deps.fleet ??
      createFleet({
        db: deps.db,
        core,
        ...(deps.now === undefined ? {} : { now: deps.now }),
        ...(deps.fleetConfig === undefined ? {} : { config: deps.fleetConfig }),
      }),
  };
  const app = new Hono<AppEnv>();
  app.onError(handleError);
  app.notFound((c) => c.json(errorBody('not_found', 'Route not found'), 404));
  app.use('*', async (c, next) => {
    c.set('deps', resolved);
    await next();
  });

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
