import { createApp } from '../../src/api/app.js';
import type { PrincipalKind, Scope } from '../../src/auth/principals.js';
import type { McpSettings } from '../../src/mcp/settings.js';
import type { SqlDatabase } from '../../src/storage/database.js';
import { openTestDatabase, seedPrincipal } from '../helpers/tower.js';
import { appRequester, McpClient } from './helpers.js';

export interface McpEnv {
  db: SqlDatabase;
  app: ReturnType<typeof createApp>;
  owner: string;
  cos: string;
  runner: string;
  principals: { owner: string; cos: string; runner: string };
  client(
    token: string | undefined,
    headers?: Record<string, string>,
  ): McpClient;
  /** An initialized session for this token. */
  session(token: string): Promise<McpClient>;
  /** The HTTP API with the same token, for cross-checking what MCP wrote. */
  http(token: string, path: string, init?: RequestInit): Promise<Response>;
  seed(
    kind: PrincipalKind,
    scopes?: readonly Scope[],
  ): { token: string; principalId: string };
}

export function createMcpEnv(
  options: { db?: SqlDatabase; mcp?: McpSettings; seed?: boolean } = {},
): McpEnv {
  const db = options.db ?? openTestDatabase();
  const owner = seedPrincipal(db, { kind: 'human', name: 'owner' });
  const cos = seedPrincipal(db, { kind: 'chief_of_staff', name: 'cos' });
  const runner = seedPrincipal(db, { kind: 'runner', name: 'runner' });
  const app = createApp({
    db,
    ...(options.mcp === undefined ? {} : { mcp: options.mcp }),
  });
  const request = appRequester(app);
  const env: McpEnv = {
    db,
    app,
    owner: owner.token,
    cos: cos.token,
    runner: runner.token,
    principals: {
      owner: owner.principalId,
      cos: cos.principalId,
      runner: runner.principalId,
    },
    client: (token, headers) => new McpClient(request, token, headers),
    async session(token) {
      const client = new McpClient(request, token);
      const reply = await client.initialize();
      if (reply.status !== 200 || client.sessionId === undefined) {
        throw new Error(`initialize failed: ${reply.status}`);
      }
      return client;
    },
    http: (token, path, init = {}) =>
      Promise.resolve(
        app.request(path, {
          ...init,
          headers: {
            authorization: `Bearer ${token}`,
            ...(init.headers ?? {}),
          },
        }),
      ),
    seed: (kind, scopes) => {
      const seeded = seedPrincipal(db, {
        kind,
        ...(scopes === undefined ? {} : { scopes }),
      });
      return { token: seeded.token, principalId: seeded.principalId };
    },
  };
  return env;
}

export const MISSION = {
  title: 'Ship the thing',
  intent: 'Get it shipped',
  outcome: 'It is shipped',
};
