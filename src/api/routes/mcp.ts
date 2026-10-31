import type { Context } from 'hono';
import { bearerChallenge } from '../../auth/oauth/challenge.js';
import { authenticateOAuth } from '../../auth/oauth/identity.js';
import {
  type AuthenticatedToken,
  authenticateToken,
} from '../../auth/tokens.js';
import { RPC_ERRORS, rpcError } from '../../mcp/jsonrpc.js';
import { createMcpServer, type McpServer } from '../../mcp/server.js';
import type { AppDependencies, AppEnv, RouteSpec } from '../app.js';
import { errorBody } from '../errors.js';
import { readJson } from './missions.js';
import { oauthOf } from './oauth.js';

const BEARER = /^Bearer\s+(\S+)$/i;
const SESSION_HEADER = 'mcp-session-id';
const NO_STORE = { 'Cache-Control': 'no-store' } as const;

const servers = new WeakMap<AppDependencies, McpServer>();

/**
 * The MCP server for this app. It is built over the services `createApp` resolved, so it shares
 * the core, its completion guards, the authority layer, the fleet and the issue service with the
 * HTTP routes. Nothing here constructs a core of its own.
 */
function serverOf(deps: AppDependencies): McpServer {
  let server = servers.get(deps);
  if (server === undefined) {
    const { core, authority, fleet, issues } = deps;
    if (
      core === undefined ||
      authority === undefined ||
      fleet === undefined ||
      issues === undefined
    ) {
      throw new Error('MCP needs the services createApp resolves');
    }
    server = createMcpServer({
      db: deps.db,
      core,
      authority,
      fleet,
      issues,
      settings: deps.mcp ?? {},
      now: deps.now ?? (() => new Date()),
    });
    servers.set(deps, server);
  }
  return server;
}

function challenge(
  c: Context<AppEnv>,
  error: 'invalid_token' | 'insufficient_scope' | undefined,
  scope?: readonly string[],
): string {
  const setup = oauthOf(c.get('deps'));
  const metadataUrl =
    setup?.provider === undefined ? undefined : setup.urls.metadata;
  return bearerChallenge({ metadataUrl, error, scope });
}

function unauthenticated(c: Context<AppEnv>, hadCredential: boolean): Response {
  return c.json(
    errorBody('unauthenticated', 'A valid bearer token is required'),
    401,
    {
      'WWW-Authenticate': challenge(
        c,
        hadCredential ? 'invalid_token' : undefined,
      ),
      ...NO_STORE,
    },
  );
}

/** A Tower token, or an access token from the configured identity provider. Nothing else. */
async function authenticateRequest(
  c: Context<AppEnv>,
): Promise<AuthenticatedToken | undefined> {
  const raw = BEARER.exec(c.req.header('authorization') ?? '')?.[1];
  if (raw === undefined) {
    return undefined;
  }
  const deps = c.get('deps');
  const now = (deps.now ?? (() => new Date()))();
  const own = authenticateToken(deps.db, raw, now);
  if (own !== undefined) {
    return own;
  }
  const setup = oauthOf(deps);
  if (setup?.provider === undefined) {
    return undefined;
  }
  return authenticateOAuth(deps.db, setup.provider, raw, {
    resource: setup.urls.resource,
    now,
  });
}

/** Refuses a browser origin nobody allowed. Requests with no `Origin` header are not from a browser. */
function originRefusal(c: Context<AppEnv>): Response | undefined {
  const origin = c.req.header('origin');
  if (origin === undefined) {
    return undefined;
  }
  const allowed = c.get('deps').mcp?.allowedOrigins ?? [];
  return allowed.includes(origin)
    ? undefined
    : c.json(
        errorBody(
          'origin_not_allowed',
          'This origin may not call the MCP endpoint',
        ),
        403,
      );
}

const post: RouteSpec = {
  method: 'post',
  path: '/mcp',
  // Public to the route table because it authenticates itself, to answer with the MCP challenge.
  access: { public: true },
  handler: async (c) => {
    const refused = originRefusal(c);
    if (refused !== undefined) {
      return refused;
    }
    const auth = await authenticateRequest(c);
    if (auth === undefined) {
      return unauthenticated(c, c.req.header('authorization') !== undefined);
    }
    let body: unknown;
    try {
      body = await readJson(c);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === 'invalid_json') {
        return c.json(
          rpcError(null, RPC_ERRORS.parse, 'The body is not valid JSON'),
          400,
        );
      }
      if (code === 'payload_too_large') {
        return c.json(
          rpcError(
            null,
            RPC_ERRORS.invalidRequest,
            'The request body is too large',
          ),
          413,
        );
      }
      throw error;
    }
    const result = await serverOf(c.get('deps')).handle({
      auth,
      sessionId: c.req.header(SESSION_HEADER),
      body,
    });
    const headers: Record<string, string> = { ...NO_STORE, ...result.headers };
    if (result.status === 403 && result.missingScopes !== undefined) {
      headers['WWW-Authenticate'] = challenge(
        c,
        'insufficient_scope',
        result.missingScopes,
      );
    }
    return result.body === undefined
      ? c.body(null, result.status as 202, headers)
      : c.json(result.body, result.status as 200, headers);
  },
};

/** Tower sends nothing unprompted, so there is no server-to-client stream to open. */
const get: RouteSpec = {
  method: 'get',
  path: '/mcp',
  access: { public: true },
  handler: async (c) => {
    const refused = originRefusal(c);
    if (refused !== undefined) {
      return refused;
    }
    if ((await authenticateRequest(c)) === undefined) {
      return unauthenticated(c, c.req.header('authorization') !== undefined);
    }
    return c.json(errorBody('method_not_allowed', 'Use POST'), 405, {
      Allow: 'POST, DELETE',
    });
  },
};

const del: RouteSpec = {
  method: 'delete',
  path: '/mcp',
  access: { public: true },
  handler: async (c) => {
    const refused = originRefusal(c);
    if (refused !== undefined) {
      return refused;
    }
    const auth = await authenticateRequest(c);
    if (auth === undefined) {
      return unauthenticated(c, c.req.header('authorization') !== undefined);
    }
    const id = c.req.header(SESSION_HEADER);
    if (id === undefined || !serverOf(c.get('deps')).endSession(auth, id)) {
      return c.json(
        errorBody('session_not_found', 'No such open session'),
        404,
      );
    }
    return c.body(null, 204);
  },
};

export const mcpRoutes: readonly RouteSpec[] = [post, get, del];
