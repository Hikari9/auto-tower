import { join } from 'node:path';
import { createApp, ROUTES } from '../../src/api/app.js';
import { dashboardRoutes } from '../../src/api/routes/dashboard.js';
import { applyMigrations } from '../../src/storage/migrate.js';
import { readMigrationFiles } from '../../src/storage/migration-files.js';
import { openSqliteDatabase } from '../../src/storage/sqlite.js';
import { seedPrincipal } from '../helpers/tower.js';

export const RUNNER_VERSION = '1.2.3';
export const RUNNER_DIGEST = `sha256:${'a'.repeat(64)}`;

/**
 * An in-process Tower with the dashboard mounted beside the API. Browser code
 * calls `fetchFor(token)` so every request goes through the same routes and
 * auth middleware a real client would hit.
 */
export function seededTower() {
  // Built here rather than with the shared helper: that helper resolves migrations through `URL`,
  // which happy-dom replaces. `import.meta.dirname` is a plain path and works in both environments.
  const db = openSqliteDatabase(':memory:');
  applyMigrations(
    db,
    readMigrationFiles(join(import.meta.dirname, '../../migrations')),
  );
  const human = seedPrincipal(db, { kind: 'human' });
  const app = createApp({ db }, [...ROUTES, ...dashboardRoutes]);
  let keys = 0;

  async function call(
    token: string | undefined,
    method: string,
    path: string,
    body?: unknown,
  ) {
    keys += 1;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'idempotency-key': `key-${keys}`,
    };
    if (token !== undefined) {
      headers.authorization = `Bearer ${token}`;
    }
    return app.request(path, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  /** A fetch that sends every request through the in-process app. */
  function fetchFor(token: string | null) {
    return async (path: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      if (token !== null) {
        headers.set('authorization', `Bearer ${token}`);
      }
      return app.request(path, { ...init, headers });
    };
  }

  return {
    app,
    db,
    token: human.token,
    call: (method: string, path: string, body?: unknown) =>
      call(human.token, method, path, body),
    fetchFor,
  };
}

export type Tower = ReturnType<typeof seededTower>;

// The response bodies here are API JSON whose shape each test asserts; `any` keeps the fixtures short.
// biome-ignore lint/suspicious/noExplicitAny: API JSON is checked by the assertions that read it
export async function json(res: Response): Promise<any> {
  return res.json();
}

/** Creates a mission through the API and returns its id. */
export async function createMission(
  tower: Tower,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const res = await tower.call('POST', '/missions', {
    title: 'Ship the pilot',
    intent: 'Pilot the new intake flow.',
    outcome: 'Intake is live for one campus.',
    constraints: ['No schema changes'],
    risk: 'low',
    size: 'm',
    priority: 'normal',
    definitionOfDone: [{ text: 'Smoke test passes', done: false }],
    source: 'test',
    parentId: null,
    requiredForParent: false,
    links: [],
    policyRefs: [],
    ...overrides,
  });
  if (res.status !== 201) {
    throw new Error(`mission create failed: ${res.status} ${await res.text()}`);
  }
  return (await json(res)).mission.id as string;
}

/** Adds a work packet and returns its id. */
export async function addPacket(
  tower: Tower,
  missionId: string,
  title: string,
  dependsOn: string[] = [],
): Promise<string> {
  const current = await json(await tower.call('GET', `/missions/${missionId}`));
  const res = await tower.call('POST', `/missions/${missionId}/work-packets`, {
    expectedVersion: current.mission.version,
    title,
    instructions: `Do ${title}.`,
    scope: ['repo:app'],
    required: true,
    dependsOn,
  });
  if (res.status !== 201) {
    throw new Error(`packet create failed: ${res.status} ${await res.text()}`);
  }
  const body = await json(res);
  const packets: { id: string; title: string }[] = body.mission.packets;
  const added = packets.find((packet) => packet.title === title);
  if (added === undefined) {
    throw new Error(`packet ${title} missing from response`);
  }
  return added.id;
}

/** Enrolls and registers a runner, returning its id. The runner's own token is not needed by the dashboard. */
export async function enrollRunner(
  tower: Tower,
  name: string,
): Promise<string> {
  const enrolled = await tower.call('POST', '/runners/enrollments', {
    name,
    version: RUNNER_VERSION,
    buildDigest: RUNNER_DIGEST,
    allowedScopes: ['*'],
  });
  const enrollment = (await json(enrolled)).enrollment;
  const registered = await tower.app.request('/runners/register', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${enrollment.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      version: RUNNER_VERSION,
      buildDigest: RUNNER_DIGEST,
      capabilities: [],
    }),
  });
  if (registered.status !== 201 && registered.status !== 200) {
    throw new Error(
      `runner register failed: ${registered.status} ${await registered.text()}`,
    );
  }
  return (await json(registered)).runnerId as string;
}

/** Creates an active allow rule and returns its id and version. */
export async function createRule(
  tower: Tower,
  action = 'repo.write',
): Promise<{ id: string; version: number }> {
  const res = await tower.call('POST', '/policy/rules', {
    effect: 'allow',
    action,
    resource: 'repo:app',
    scope: 'repo:app',
    maxRisk: 'low',
    grantee: { kind: 'chief_of_staff' },
    limits: {},
    expiresAt: null,
    note: 'pilot',
  });
  if (res.status !== 201) {
    throw new Error(`rule create failed: ${res.status} ${await res.text()}`);
  }
  const rule = (await json(res)).rule;
  return { id: rule.id as string, version: rule.version as number };
}
