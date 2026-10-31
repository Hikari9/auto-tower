import type { Context } from 'hono';
import { Hono } from 'hono';
import {
  type AuthVariables,
  authenticate,
  requireScopes,
} from '../auth/middleware.js';
import type { Scope } from '../auth/principals.js';
import type { Core } from '../core/index.js';
import type { Authority } from '../decisions/index.js';
import type { IssueProvider, IssueService } from '../issues/index.js';
import type { SqlDatabase } from '../storage/database.js';
import { errorBody, handleError } from './errors.js';
import { decisionRoutes } from './routes/decisions.js';
import { healthRoute } from './routes/health.js';
import { issueRoutes, issuesOf } from './routes/issues.js';
import { missionRoutes } from './routes/missions.js';
import { policyRoutes } from './routes/policy.js';
import { type WebhookSettings, webhookRoutes } from './routes/webhooks.js';
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
  ...issueRoutes,
];

export interface AppDependencies {
  db: SqlDatabase;
  now?: () => Date;
  /** Mission core. Built over `db` when absent. Tests and hosts inject one to control the runner pool and clock. */
  core?: Core;
  /** Policy store, Decision Inbox and tier routing. Built over `db` and the core's guards when absent. */
  authority?: Authority;
  /** Issue links, sync and reconciliation. Built over the core, authority and `issueProviders` when absent. */
  issues?: IssueService;
  /** Provider adapters by id, such as the GitHub provider. With none, links are stored and nothing is fetched. */
  issueProviders?: Readonly<Record<string, IssueProvider>>;
  /**
   * Webhook secrets and actors. Without it no webhook route is mounted. Routes are signed, not
   * token-authenticated, which is why they are not in `ROUTES`.
   */
  webhooks?: WebhookSettings;
}

export function createApp(
  deps: AppDependencies,
  routes: readonly RouteSpec[] = ROUTES,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.onError(handleError);
  app.notFound((c) => c.json(errorBody('not_found', 'Route not found'), 404));
  app.use('*', async (c, next) => {
    c.set('deps', deps);
    // Wires the required-issues completion guard before any route can complete a mission.
    issuesOf(c);
    await next();
  });

  const mounted =
    deps.webhooks === undefined ? routes : [...routes, ...webhookRoutes];
  for (const route of mounted) {
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
