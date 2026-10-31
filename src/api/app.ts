import type { Context } from 'hono';
import { Hono } from 'hono';
import { createOfficeReviewGuard } from '../adapters/office/ledger.js';
import {
  type AuthVariables,
  authenticate,
  requireScopes,
} from '../auth/middleware.js';
import type { AuthProvider } from '../auth/oauth/provider.js';
import type { Scope } from '../auth/principals.js';
import { createCompletionGuardRegistry } from '../core/guards.js';
import { type Core, createCore } from '../core/index.js';
import { type Authority, createAuthority } from '../decisions/index.js';
import {
  createFleet,
  createPool,
  type Fleet,
  type FleetConfig,
} from '../fleet/index.js';
import {
  createIssueService,
  type IssueProvider,
  type IssueService,
} from '../issues/index.js';
import type { McpSettings } from '../mcp/settings.js';
import type { SqlDatabase } from '../storage/database.js';
import { errorBody, handleError } from './errors.js';
import { decisionRoutes } from './routes/decisions.js';
import { healthRoute } from './routes/health.js';
import { issueRoutes } from './routes/issues.js';
import { mcpRoutes } from './routes/mcp.js';
import { missionRoutes } from './routes/missions.js';
import { oauthOf, oauthRoutes } from './routes/oauth.js';
import { policyRoutes } from './routes/policy.js';
import { runnerRoutes } from './routes/runners.js';
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
  ...runnerRoutes,
  ...issueRoutes,
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
  /** Issue links, sync and reconciliation. Built over the core, authority and `issueProviders` when absent. */
  issues?: IssueService;
  /** Provider adapters by id, such as the GitHub provider. With none, links are stored and nothing is fetched. */
  issueProviders?: Readonly<Record<string, IssueProvider>>;
  /**
   * Webhook secrets and actors. Without it no webhook route is mounted. Routes are signed, not
   * token-authenticated, which is why they are not in `ROUTES`.
   */
  webhooks?: WebhookSettings;
  /**
   * The MCP endpoint's origin policy, public URL, approved AI providers and identity provider.
   * The endpoint is always mounted and always demands a credential. Without `publicBaseUrl` it
   * serves Tower tokens only and publishes no OAuth metadata.
   */
  mcp?: McpSettings;
}

export type { AuthProvider };

/** The core's default completion guards, plus the Auto-Office high-risk review gate. */
function officeGuards(db: SqlDatabase) {
  const guards = createCompletionGuardRegistry();
  guards.register(createOfficeReviewGuard(db));
  return guards;
}

export type ResolvedDependencies = AppDependencies & {
  core: Core;
  authority: Authority;
  fleet: Fleet;
  issues: IssueService;
};

/**
 * Every service the HTTP routes and the MCP endpoint share. This is the one place a core is built
 * and the one place its completion guards are made certain, so no entry point can complete a
 * mission with a guard missing. A core a host injects gets the Auto-Office review guard and the
 * required-issues guard registered on it when it lacks them.
 */
export function resolveDependencies(
  deps: AppDependencies,
): ResolvedDependencies {
  // The fleet's broker is the scheduler's runner pool, so a core built here dispatches to real runners.
  const core =
    deps.core ??
    createCore({
      db: deps.db,
      guards: officeGuards(deps.db),
      ...(deps.now === undefined ? {} : { clock: deps.now }),
      pool: createPool({
        db: deps.db,
        ...(deps.now === undefined ? {} : { now: deps.now }),
        ...(deps.fleetConfig === undefined ? {} : { config: deps.fleetConfig }),
      }),
    });
  const office = createOfficeReviewGuard(deps.db);
  if (!core.guards.list().some((guard) => guard.name === office.name)) {
    core.guards.register(office);
  }
  const authority =
    deps.authority ??
    createAuthority({
      db: deps.db,
      guards: core.guards,
      ...(deps.now === undefined ? {} : { clock: deps.now }),
    });
  // Building the issue service registers the required-issues completion guard on `core.guards`.
  const issues =
    deps.issues ??
    createIssueService({
      db: deps.db,
      core,
      policy: authority.policy,
      ...(deps.issueProviders === undefined
        ? {}
        : { providers: deps.issueProviders }),
      ...(deps.now === undefined ? {} : { clock: deps.now }),
    });
  const fleet =
    deps.fleet ??
    createFleet({
      db: deps.db,
      core,
      ...(deps.now === undefined ? {} : { now: deps.now }),
      ...(deps.fleetConfig === undefined ? {} : { config: deps.fleetConfig }),
    });
  return { ...deps, core, authority, issues, fleet };
}

export function createApp(
  deps: AppDependencies,
  routes: readonly RouteSpec[] = ROUTES,
): Hono<AppEnv> {
  const resolved: AppDependencies = resolveDependencies(deps);
  // A bad public URL fails here, at startup, and not on the first request.
  oauthOf(resolved);
  const app = new Hono<AppEnv>();
  app.onError(handleError);
  app.notFound((c) => c.json(errorBody('not_found', 'Route not found'), 404));
  app.use('*', async (c, next) => {
    c.set('deps', resolved);
    await next();
  });

  // Signed or self-authenticating routes sit outside `ROUTES`, so /health stays the only public one.
  const mounted = [
    ...routes,
    ...(deps.webhooks === undefined ? [] : webhookRoutes),
    ...mcpRoutes,
    ...oauthRoutes,
  ];
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
