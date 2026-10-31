import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { guarded } from '../../src/api/routes/missions.js';
import { ForbiddenActorError } from '../../src/core/errors.js';
import { createCore } from '../../src/core/index.js';
import type { SqlDatabase } from '../../src/storage/database.js';
import { FakeClock, FakePool, sequentialIds } from '../core/helpers.js';
import {
  openTestDatabase,
  seedPrincipal,
  tempDbPath,
} from '../helpers/tower.js';

interface Api {
  db: SqlDatabase;
  core: ReturnType<typeof createCore>;
  pool: FakePool;
  owner: { token: string; principalId: string };
  cos: { token: string; principalId: string };
  runner: { token: string; principalId: string };
  call(
    token: string | undefined,
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
    // biome-ignore lint/suspicious/noExplicitAny: test responses are untyped JSON
  ): Promise<{ status: number; body: any }>;
}

function setup(
  db: SqlDatabase = openTestDatabase(),
  workspaceId = 'ws_test',
): Api {
  const pool = new FakePool();
  const clock = new FakeClock();
  const core = createCore({
    db,
    pool,
    clock: clock.now,
    newId: sequentialIds(),
  });
  const app = createApp({ db, now: clock.now, core });
  const owner = seedPrincipal(db, { kind: 'human', workspaceId });
  const cos = seedPrincipal(db, { kind: 'chief_of_staff', workspaceId });
  const runner = seedPrincipal(db, { kind: 'runner', workspaceId });
  return {
    db,
    core,
    pool,
    owner,
    cos,
    runner,
    async call(token, method, path, body, headers = {}) {
      const res = await app.request(path, {
        method,
        headers: {
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined
          ? {}
          : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      });
      const text = await res.text();
      return {
        status: res.status,
        body: text === '' ? undefined : JSON.parse(text),
      };
    },
  };
}

const NEW_MISSION = {
  title: 'Launch',
  intent: 'Launch the product',
  outcome: 'It is live',
};

async function createMission(
  api: Api,
  body: object = NEW_MISSION,
  token = api.owner.token,
) {
  const res = await api.call(token, 'POST', '/missions', body);
  expect(res.status).toBe(201);
  return res.body.mission as { id: string; version: number; state: string };
}

describe('mission API access', () => {
  it('requires a bearer token on every mission route', async () => {
    const api = setup();
    for (const [method, path] of [
      ['POST', '/missions'],
      ['GET', '/missions'],
      ['GET', '/missions/m1'],
      ['PATCH', '/missions/m1'],
      ['POST', '/missions/m1/cancel'],
      ['POST', '/missions/m1/transitions'],
      ['POST', '/missions/m1/outcome-verification'],
      ['GET', '/missions/m1/activity'],
      ['POST', '/missions/m1/work-packets'],
      ['GET', '/missions/m1/work-packets'],
      ['POST', '/missions/m1/work-packets/p1/dependencies'],
      ['POST', '/missions/m1/work-packets/p1/authorize'],
      ['POST', '/missions/m1/work-packets/p1/verify'],
      ['POST', '/missions/m1/work-packets/p1/reject'],
      ['POST', '/missions/m1/work-packets/p1/requeue'],
      ['POST', '/work/schedule'],
    ] as const) {
      const res = await api.call(
        undefined,
        method,
        path,
        method === 'GET' ? undefined : {},
      );
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it('lets a runner read but never write missions', async () => {
    const api = setup();
    const m = await createMission(api);

    expect(
      (await api.call(api.runner.token, 'GET', `/missions/${m.id}`)).status,
    ).toBe(200);
    expect((await api.call(api.runner.token, 'GET', '/missions')).status).toBe(
      200,
    );
    for (const [method, path] of [
      ['POST', '/missions'],
      ['PATCH', `/missions/${m.id}`],
      ['POST', `/missions/${m.id}/cancel`],
      ['POST', `/missions/${m.id}/transitions`],
      ['POST', `/missions/${m.id}/work-packets`],
      ['POST', '/work/schedule'],
    ] as const) {
      const res = await api.call(api.runner.token, method, path, {
        expectedVersion: 1,
      });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    expect(
      (await api.call(api.owner.token, 'GET', `/missions/${m.id}`)).body.mission
        .version,
    ).toBe(1);
  });

  it('refuses a read-only token on writes', async () => {
    const api = setup();
    const readOnly = seedPrincipal(api.db, {
      kind: 'human',
      scopes: ['mission:read'],
    });
    expect(
      (await api.call(readOnly.token, 'POST', '/missions', NEW_MISSION)).status,
    ).toBe(403);
    expect((await api.call(readOnly.token, 'GET', '/missions')).status).toBe(
      200,
    );
  });
});

describe('create, read, search, update, cancel', () => {
  it('round-trips a mission through create and read', async () => {
    const api = setup();
    const res = await api.call(api.cos.token, 'POST', '/missions', {
      ...NEW_MISSION,
      constraints: ['stay in budget'],
      risk: 'high',
      size: 'xl',
      priority: 'urgent',
      definitionOfDone: [{ text: 'Announced' }],
      links: [
        {
          url: 'https://github.com/o/r/issues/1',
          classification: 'required',
          title: 'Tracking',
        },
      ],
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      replayed: false,
      event: { version: 1, type: 'mission.created' },
      mission: {
        state: 'draft',
        version: 1,
        risk: 'high',
        createdBy: api.cos.principalId,
      },
    });

    const read = await api.call(
      api.owner.token,
      'GET',
      `/missions/${res.body.mission.id}`,
    );
    expect(read.status).toBe(200);
    expect(read.body.mission).toEqual(res.body.mission);
    expect(read.body.mission.definitionOfDone).toEqual([
      { text: 'Announced', done: false },
    ]);
  });

  it('answers 400 with field-level details for invalid input', async () => {
    const api = setup();
    const res = await api.call(api.owner.token, 'POST', '/missions', {
      title: '',
      links: [{ url: 'javascript:1', classification: 'required' }],
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_failed');
    expect(res.body.error.details.issues).toEqual(
      expect.arrayContaining([
        { path: 'title', message: 'must not be empty' },
        { path: 'links[0].url', message: 'must use http or https' },
      ]),
    );
  });

  it('answers 400 for malformed JSON and 413 for an oversized body', async () => {
    const api = setup();
    const bad = await api.call(
      api.owner.token,
      'POST',
      '/missions',
      '{not json',
    );
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_json');

    const big = await api.call(
      api.owner.token,
      'POST',
      '/missions',
      JSON.stringify({ ...NEW_MISSION, intent: 'x'.repeat(300_000) }),
    );
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('payload_too_large');
  });

  it('rejects an out-of-range or malformed idempotency header', async () => {
    const api = setup();
    for (const key of ['', 'k'.repeat(129), 'has space', 'tab\tkey']) {
      const res = await api.call(
        api.owner.token,
        'POST',
        '/missions',
        NEW_MISSION,
        { 'idempotency-key': key },
      );
      expect(res.status, JSON.stringify(key)).toBe(400);
    }
  });

  it('searches by text, state and priority with paging and a true total', async () => {
    const api = setup();
    await createMission(api, { ...NEW_MISSION, title: 'Alpha launch' });
    const b = await createMission(api, {
      ...NEW_MISSION,
      title: 'Beta launch',
      priority: 'high',
    });
    await createMission(api, {
      ...NEW_MISSION,
      title: '50% rollout',
      intent: 'ramp',
    });
    await api.call(api.owner.token, 'POST', `/missions/${b.id}/transitions`, {
      expectedVersion: 1,
      to: 'ready',
    });

    const byText = await api.call(api.owner.token, 'GET', '/missions?q=launch');
    expect(byText.body.total).toBe(2);
    expect(
      byText.body.items.map((i: { title: string }) => i.title).sort(),
    ).toEqual(['Alpha launch', 'Beta launch']);

    expect(
      (await api.call(api.owner.token, 'GET', '/missions?state=ready')).body
        .items,
    ).toHaveLength(1);
    expect(
      (await api.call(api.owner.token, 'GET', '/missions?priority=high')).body
        .total,
    ).toBe(1);
    // A literal percent sign must not act as a wildcard.
    expect(
      (
        await api.call(api.owner.token, 'GET', '/missions?q=50%25')
      ).body.items.map((i: { title: string }) => i.title),
    ).toEqual(['50% rollout']);
    expect(
      (await api.call(api.owner.token, 'GET', '/missions?q=%25')).body.total,
    ).toBe(1);

    const page = await api.call(
      api.owner.token,
      'GET',
      '/missions?limit=2&offset=2',
    );
    expect(page.body).toMatchObject({ total: 3, limit: 2, offset: 2 });
    expect(page.body.items).toHaveLength(1);
    expect(
      (await api.call(api.owner.token, 'GET', '/missions?limit=1000')).status,
    ).toBe(400);
    expect(
      (await api.call(api.owner.token, 'GET', '/missions?state=bogus')).status,
    ).toBe(400);
  });

  it('updates with an expected version and answers 409 for a stale one', async () => {
    const api = setup();
    const m = await createMission(api);

    const ok = await api.call(api.owner.token, 'PATCH', `/missions/${m.id}`, {
      expectedVersion: 1,
      title: 'Renamed',
      priority: 'high',
    });
    expect(ok.status).toBe(200);
    expect(ok.body.mission).toMatchObject({
      version: 2,
      title: 'Renamed',
      priority: 'high',
    });

    const stale = await api.call(
      api.owner.token,
      'PATCH',
      `/missions/${m.id}`,
      { expectedVersion: 1, title: 'Lost update' },
    );
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('version_conflict');
    expect(
      (await api.call(api.owner.token, 'GET', `/missions/${m.id}`)).body.mission
        .title,
    ).toBe('Renamed');
  });

  it('answers 409 for an invalid transition and leaves the mission unchanged', async () => {
    const api = setup();
    const m = await createMission(api);

    const res = await api.call(
      api.owner.token,
      'POST',
      `/missions/${m.id}/transitions`,
      { expectedVersion: 1, to: 'completed' },
    );

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('invalid_transition');
    expect(
      (await api.call(api.owner.token, 'GET', `/missions/${m.id}`)).body
        .mission,
    ).toMatchObject({ version: 1, state: 'draft' });
  });

  it('cancels without touching linked issues and keeps the history', async () => {
    const api = setup();
    const m = await createMission(api, {
      ...NEW_MISSION,
      links: [
        { url: 'https://github.com/o/r/issues/1', classification: 'required' },
      ],
    });
    const links = (await api.call(api.owner.token, 'GET', `/missions/${m.id}`))
      .body.mission.links;

    const res = await api.call(
      api.owner.token,
      'POST',
      `/missions/${m.id}/cancel`,
      { expectedVersion: 1, reason: 'obsolete' },
    );

    expect(res.status).toBe(200);
    expect(res.body.mission).toMatchObject({ state: 'cancelled', links });
    const activity = await api.call(
      api.owner.token,
      'GET',
      `/missions/${m.id}/activity`,
    );
    expect(activity.body.items.map((i: { type: string }) => i.type)).toEqual([
      'mission.created',
      'mission.transitioned',
    ]);
    // A cancelled mission cannot be revived.
    expect(
      (
        await api.call(
          api.owner.token,
          'POST',
          `/missions/${m.id}/transitions`,
          { expectedVersion: 2, to: 'ready' },
        )
      ).status,
    ).toBe(409);
  });

  it('reads activity in order with paging', async () => {
    const api = setup();
    const m = await createMission(api);
    await api.call(
      api.owner.token,
      'PATCH',
      `/missions/${m.id}`,
      { expectedVersion: 1, title: 'two' },
      { 'x-correlation-id': 'corr-A' },
    );
    await api.call(api.owner.token, 'POST', `/missions/${m.id}/transitions`, {
      expectedVersion: 2,
      to: 'planning',
    });

    const all = await api.call(
      api.owner.token,
      'GET',
      `/missions/${m.id}/activity`,
    );
    expect(all.body.items.map((i: { version: number }) => i.version)).toEqual([
      1, 2, 3,
    ]);
    expect(all.body.items[1]).toMatchObject({
      actorId: api.owner.principalId,
      correlationId: 'corr-A',
      stateAfter: 'draft',
    });
    expect(all.body.items[2].stateAfter).toBe('planning');
    expect(all.body.nextAfterVersion).toBeNull();

    const first = await api.call(
      api.owner.token,
      'GET',
      `/missions/${m.id}/activity?limit=2`,
    );
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextAfterVersion).toBe(2);
    const rest = await api.call(
      api.owner.token,
      'GET',
      `/missions/${m.id}/activity?after=2&limit=2`,
    );
    expect(rest.body.items.map((i: { version: number }) => i.version)).toEqual([
      3,
    ]);
  });
});

describe('idempotency over HTTP', () => {
  it('answers a repeated create with the first result: 201 then 200, one mission', async () => {
    const api = setup();
    const headers = { 'idempotency-key': 'create-launch' };

    const first = await api.call(
      api.owner.token,
      'POST',
      '/missions',
      NEW_MISSION,
      headers,
    );
    const second = await api.call(
      api.owner.token,
      'POST',
      '/missions',
      NEW_MISSION,
      headers,
    );

    expect([first.status, second.status]).toEqual([201, 200]);
    expect(second.body).toMatchObject({
      replayed: true,
      mission: first.body.mission,
      event: first.body.event,
    });
    expect(
      (await api.call(api.owner.token, 'GET', '/missions')).body.total,
    ).toBe(1);
  });

  it('answers 409 when the key is reused with a different body', async () => {
    const api = setup();
    const headers = { 'idempotency-key': 'k' };
    await api.call(api.owner.token, 'POST', '/missions', NEW_MISSION, headers);

    const res = await api.call(
      api.owner.token,
      'POST',
      '/missions',
      { ...NEW_MISSION, title: 'Different' },
      headers,
    );

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('idempotency_key_reused');
  });

  it('keeps one key from one caller from replaying into another caller', async () => {
    const api = setup();
    const a = await api.call(
      api.owner.token,
      'POST',
      '/missions',
      NEW_MISSION,
      { 'idempotency-key': 'shared' },
    );
    const b = await api.call(api.cos.token, 'POST', '/missions', NEW_MISSION, {
      'idempotency-key': 'shared',
    });

    expect(b.status).toBe(201);
    expect(b.body.mission.id).not.toBe(a.body.mission.id);
  });
});

describe('workspace isolation', () => {
  function twoWorkspaces() {
    const api = setup();
    const other = seedPrincipal(api.db, {
      kind: 'human',
      workspaceId: 'ws_other',
    });
    return { api, other };
  }

  it('hides missions from another workspace on read, update, cancel, activity and packets', async () => {
    const { api, other } = twoWorkspaces();
    const m = await createMission(api);

    for (const [method, path, body] of [
      ['GET', `/missions/${m.id}`, undefined],
      ['GET', `/missions/${m.id}/activity`, undefined],
      ['GET', `/missions/${m.id}/work-packets`, undefined],
      ['PATCH', `/missions/${m.id}`, { expectedVersion: 1, title: 'hijack' }],
      ['POST', `/missions/${m.id}/cancel`, { expectedVersion: 1 }],
      [
        'POST',
        `/missions/${m.id}/transitions`,
        { expectedVersion: 1, to: 'ready' },
      ],
      [
        'POST',
        `/missions/${m.id}/work-packets`,
        { expectedVersion: 1, title: 'x' },
      ],
    ] as const) {
      const res = await api.call(other.token, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(res.body.error.code).toBe('mission_not_found');
    }
    expect(
      (await api.call(api.owner.token, 'GET', `/missions/${m.id}`)).body
        .mission,
    ).toMatchObject({ version: 1, title: 'Launch' });
  });

  it('keeps search results inside the caller workspace', async () => {
    const { api, other } = twoWorkspaces();
    await createMission(api, { ...NEW_MISSION, title: 'Ours' });
    await createMission(api, { ...NEW_MISSION, title: 'Theirs' }, other.token);

    const ours = await api.call(api.owner.token, 'GET', '/missions');
    const theirs = await api.call(other.token, 'GET', '/missions?q=Ours');

    expect(ours.body.items.map((i: { title: string }) => i.title)).toEqual([
      'Ours',
    ]);
    expect(theirs.body).toMatchObject({ total: 0, items: [] });
  });

  it('refuses a parent from another workspace', async () => {
    const { api, other } = twoWorkspaces();
    const foreign = await createMission(api, NEW_MISSION, other.token);

    const res = await api.call(api.owner.token, 'POST', '/missions', {
      ...NEW_MISSION,
      parentId: foreign.id,
    });

    expect(res.status).toBe(400);
    expect(res.body.error.details.issues).toEqual([
      { path: 'parentId', message: 'is not a mission in this workspace' },
    ]);
  });

  it('does not let the workspace be chosen by the request', async () => {
    const { api } = twoWorkspaces();
    const res = await api.call(api.owner.token, 'POST', '/missions', {
      ...NEW_MISSION,
      workspaceId: 'ws_other',
    });
    expect(res.status).toBe(400);
  });

  it('does not replay an idempotent create into another workspace', async () => {
    const { api, other } = twoWorkspaces();
    const a = await api.call(
      api.owner.token,
      'POST',
      '/missions',
      NEW_MISSION,
      { 'idempotency-key': 'same' },
    );
    const b = await api.call(other.token, 'POST', '/missions', NEW_MISSION, {
      'idempotency-key': 'same',
    });
    expect(b.status).toBe(201);
    expect(b.body.mission.id).not.toBe(a.body.mission.id);
    expect(b.body.mission.workspaceId).toBe('ws_other');
  });
});

/** The runner's side of an attempt, through the core, since runner routes belong to a later task. */
async function reportAsRunner(
  api: Api,
  missionId: string,
  packetId: string,
  outcome: 'succeeded' | 'failed',
) {
  const read = async () =>
    (await api.call(api.owner.token, 'GET', `/missions/${missionId}`)).body
      .mission;
  const runner = { id: api.runner.principalId, kind: 'runner' as const };
  const ctx = { workspaceId: 'ws_test', actor: runner };
  const attemptId = (await read()).packets.find(
    (p: { id: string }) => p.id === packetId,
  ).activeAttemptId as string;
  api.core.missions.startAttempt(
    ctx,
    missionId,
    (await read()).version,
    attemptId,
  );
  api.core.missions.reportAttempt(
    ctx,
    missionId,
    (await read()).version,
    attemptId,
    outcome,
    null,
  );
}

describe('work packets, completion and the scheduler over HTTP', () => {
  async function started(api: Api) {
    const m = await createMission(api);
    await api.call(api.owner.token, 'POST', `/missions/${m.id}/transitions`, {
      expectedVersion: 1,
      to: 'ready',
    });
    return m.id;
  }

  async function version(api: Api, id: string) {
    return (await api.call(api.owner.token, 'GET', `/missions/${id}`)).body
      .mission.version as number;
  }

  it('reports waiting-runner for authorized work with no runner, then runs it when one appears', async () => {
    const api = setup();
    const id = await started(api);
    const added = await api.call(
      api.owner.token,
      'POST',
      `/missions/${id}/work-packets`,
      { expectedVersion: 2, title: 'Build' },
    );
    expect(added.status).toBe(201);
    const packetId = added.body.mission.packets[0].id;
    await api.call(
      api.owner.token,
      'POST',
      `/missions/${id}/work-packets/${packetId}/authorize`,
      { expectedVersion: 3 },
    );

    const idle = await api.call(api.owner.token, 'POST', '/work/schedule');
    expect(idle.status).toBe(200);
    expect(idle.body.changes).toEqual([
      expect.objectContaining({ missionId: id, to: 'waiting-runner' }),
    ]);
    expect(
      (await api.call(api.owner.token, 'GET', `/missions/${id}`)).body.mission
        .state,
    ).toBe('waiting-runner');

    api.pool.online = [api.runner.principalId];
    await api.call(api.owner.token, 'POST', '/work/schedule');
    const running = (
      await api.call(api.owner.token, 'GET', `/missions/${id}/work-packets`)
    ).body;
    expect(running.packets[0]).toMatchObject({ status: 'leased' });
    expect(running.attempts[0]).toMatchObject({
      runnerId: api.runner.principalId,
      status: 'leased',
    });
    expect(
      (await api.call(api.owner.token, 'POST', '/work/schedule')).body.changes,
    ).toEqual([]);
  });

  it('answers 422 for a dependency cycle and 404 for an unknown packet', async () => {
    const api = setup();
    const id = await started(api);
    const a = (
      await api.call(api.owner.token, 'POST', `/missions/${id}/work-packets`, {
        expectedVersion: 2,
        title: 'A',
      })
    ).body.mission.packets[0].id;
    const b = (
      await api.call(api.owner.token, 'POST', `/missions/${id}/work-packets`, {
        expectedVersion: 3,
        title: 'B',
        dependsOn: [a],
      })
    ).body.mission.packets[1].id;

    const cycle = await api.call(
      api.owner.token,
      'POST',
      `/missions/${id}/work-packets/${a}/dependencies`,
      { expectedVersion: 4, dependsOn: b },
    );
    expect(cycle.status).toBe(422);
    expect(cycle.body.error).toMatchObject({
      code: 'dependency_cycle',
      details: { path: [a, b, a] },
    });

    const missing = await api.call(
      api.owner.token,
      'POST',
      `/missions/${id}/work-packets/pkt_nope/authorize`,
      { expectedVersion: 4 },
    );
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('packet_not_found');
  });

  it('refuses completion with the failing guards, then allows it once verified', async () => {
    const api = setup();
    const id = await started(api);
    const packetId = (
      await api.call(api.owner.token, 'POST', `/missions/${id}/work-packets`, {
        expectedVersion: 2,
        title: 'Build',
      })
    ).body.mission.packets[0].id;
    await api.call(api.owner.token, 'POST', `/missions/${id}/transitions`, {
      expectedVersion: 3,
      to: 'verifying',
    });

    const refused = await api.call(
      api.owner.token,
      'POST',
      `/missions/${id}/transitions`,
      { expectedVersion: 4, to: 'completed' },
    );
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('completion_guard_failed');
    expect(
      refused.body.error.details.failures
        .map((f: { guard: string }) => f.guard)
        .sort(),
    ).toEqual(['outcome-verified', 'required-packets-verified']);

    const noEvidence = await api.call(
      api.owner.token,
      'POST',
      `/missions/${id}/outcome-verification`,
      { expectedVersion: 4, evidenceRefs: [] },
    );
    expect(noEvidence.status).toBe(400);
    expect(noEvidence.body.error.details.issues).toEqual([
      { path: 'evidenceRefs', message: 'needs at least one reference' },
    ]);
    expect(await version(api, id)).toBe(4);

    // Verify the packet properly, record outcome evidence, and completion goes through.
    await api.call(api.owner.token, 'POST', `/missions/${id}/transitions`, {
      expectedVersion: 4,
      to: 'ready',
    });
    await api.call(
      api.owner.token,
      'POST',
      `/missions/${id}/work-packets/${packetId}/authorize`,
      { expectedVersion: 5 },
    );
    api.pool.online = [api.runner.principalId];
    await api.call(api.owner.token, 'POST', '/work/schedule');
    await reportAsRunner(api, id, packetId, 'succeeded');
    const verify = await api.call(
      api.owner.token,
      'POST',
      `/missions/${id}/work-packets/${packetId}/verify`,
      { expectedVersion: await version(api, id), evidenceRefs: ['ci:run/7'] },
    );
    expect(verify.status).toBe(200);
    await api.call(api.owner.token, 'POST', '/work/schedule');
    expect(
      (await api.call(api.owner.token, 'GET', `/missions/${id}`)).body.mission
        .state,
    ).toBe('verifying');
    await api.call(
      api.owner.token,
      'POST',
      `/missions/${id}/outcome-verification`,
      { expectedVersion: await version(api, id), evidenceRefs: ['review:ok'] },
    );
    const done = await api.call(
      api.owner.token,
      'POST',
      `/missions/${id}/transitions`,
      {
        expectedVersion: await version(api, id),
        to: 'completed',
      },
    );
    expect(done.status).toBe(200);
    expect(done.body.mission.state).toBe('completed');
  });

  it('completes a mission through verifying with verified evidence and records it in the history', async () => {
    const api = setup();
    const id = await started(api);
    await api.call(api.owner.token, 'POST', `/missions/${id}/transitions`, {
      expectedVersion: 2,
      to: 'verifying',
    });

    const verified = await api.call(
      api.cos.token,
      'POST',
      `/missions/${id}/outcome-verification`,
      { expectedVersion: 3, evidenceRefs: ['ci:run/42'] },
    );
    expect(verified.status).toBe(200);
    expect(verified.body.mission.outcomeVerification).toMatchObject({
      by: api.cos.principalId,
      evidenceRefs: ['ci:run/42'],
    });

    const done = await api.call(
      api.owner.token,
      'POST',
      `/missions/${id}/transitions`,
      { expectedVersion: 4, to: 'completed' },
    );
    expect(done.status).toBe(200);
    expect(done.body.mission).toMatchObject({
      state: 'completed',
      evidenceRefs: ['ci:run/42'],
    });
    const activity = await api.call(
      api.owner.token,
      'GET',
      `/missions/${id}/activity`,
    );
    expect(
      activity.body.items.map((i: { type: string; stateAfter: string }) => [
        i.type,
        i.stateAfter,
      ]),
    ).toEqual([
      ['mission.created', 'draft'],
      ['mission.transitioned', 'ready'],
      ['mission.transitioned', 'verifying'],
      ['mission.outcome_verified', 'verifying'],
      ['mission.transitioned', 'completed'],
    ]);
  });
});

describe('restart over HTTP', () => {
  it('serves the same missions from a reopened database file', async () => {
    const path = tempDbPath();
    const first = setup(openTestDatabase(path));
    const m = await createMission(first, { ...NEW_MISSION, title: 'Durable' });
    await first.call(
      first.owner.token,
      'POST',
      `/missions/${m.id}/transitions`,
      { expectedVersion: 1, to: 'planning' },
    );
    const before = (
      await first.call(first.owner.token, 'GET', `/missions/${m.id}`)
    ).body;
    first.db.close();

    const db = openTestDatabase(path);
    const core = createCore({ db });
    const app = createApp({ db, core });
    const res = await app.request(`/missions/${m.id}`, {
      headers: { authorization: `Bearer ${first.owner.token}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(before);
    const list = await app.request('/missions?q=Durable', {
      headers: { authorization: `Bearer ${first.owner.token}` },
    });
    expect(((await list.json()) as { total: number }).total).toBe(1);
  });
});

describe('write routes need the write scope', () => {
  const V = { expectedVersion: 1 };
  const WRITES: Array<[string, (id: string) => string, object]> = [
    ['POST', () => '/missions', {}],
    ['PATCH', (id) => `/missions/${id}`, { ...V, title: 'x' }],
    ['POST', (id) => `/missions/${id}/cancel`, V],
    ['POST', (id) => `/missions/${id}/transitions`, { ...V, to: 'ready' }],
    [
      'POST',
      (id) => `/missions/${id}/outcome-verification`,
      { ...V, evidenceRefs: ['e'] },
    ],
    ['POST', (id) => `/missions/${id}/work-packets`, { ...V, title: 'x' }],
    [
      'POST',
      (id) => `/missions/${id}/work-packets/p1/dependencies`,
      { ...V, dependsOn: 'p2' },
    ],
    ['POST', (id) => `/missions/${id}/work-packets/p1/authorize`, V],
    [
      'POST',
      (id) => `/missions/${id}/work-packets/p1/verify`,
      { ...V, evidenceRefs: ['e'] },
    ],
    ['POST', (id) => `/missions/${id}/work-packets/p1/reject`, V],
    ['POST', (id) => `/missions/${id}/work-packets/p1/requeue`, V],
    ['POST', () => '/work/schedule', {}],
  ];

  it('refuses a read-only token on every one and changes nothing', async () => {
    const api = setup();
    const m = await createMission(api);
    const readOnly = seedPrincipal(api.db, {
      kind: 'human',
      scopes: ['mission:read'],
    });
    for (const [method, path, body] of WRITES) {
      const res = await api.call(readOnly.token, method, path(m.id), body);
      expect(res.status, `${method} ${path(m.id)}`).toBe(403);
    }
    expect(
      (await api.call(api.owner.token, 'GET', `/missions/${m.id}`)).body.mission
        .version,
    ).toBe(1);
  });

  it('keeps every mission-scoped route inside the caller workspace', async () => {
    const api = setup();
    const other = seedPrincipal(api.db, {
      kind: 'human',
      workspaceId: 'ws_other',
    });
    const m = await createMission(api);
    for (const [method, path, body] of WRITES.slice(1, -1)) {
      const res = await api.call(other.token, method, path(m.id), body);
      expect(res.status, `${method} ${path(m.id)}`).toBe(404);
      expect(res.body.error.code).toBe('mission_not_found');
    }
    expect(
      (await api.call(api.owner.token, 'GET', `/missions/${m.id}`)).body.mission
        .version,
    ).toBe(1);
  });

  it('runs the scheduler only over the caller workspace', async () => {
    const api = setup();
    const other = seedPrincipal(api.db, {
      kind: 'human',
      workspaceId: 'ws_other',
    });
    const mine = await createMission(api);
    await api.call(
      api.owner.token,
      'POST',
      `/missions/${mine.id}/transitions`,
      { expectedVersion: 1, to: 'ready' },
    );
    const added = await api.call(
      api.owner.token,
      'POST',
      `/missions/${mine.id}/work-packets`,
      { expectedVersion: 2, title: 'a' },
    );
    await api.call(
      api.owner.token,
      'POST',
      `/missions/${mine.id}/work-packets/${added.body.mission.packets[0].id}/authorize`,
      { expectedVersion: 3 },
    );

    const theirs = await api.call(other.token, 'POST', '/work/schedule');
    expect(theirs.body.changes).toEqual([]);
    expect(
      (await api.call(api.owner.token, 'GET', `/missions/${mine.id}`)).body
        .mission.state,
    ).toBe('ready');

    const ours = await api.call(api.owner.token, 'POST', '/work/schedule');
    expect(ours.body.changes).toHaveLength(1);
  });
});

describe('packet verification over HTTP', () => {
  async function reported(api: Api) {
    const m = await createMission(api);
    await api.call(api.owner.token, 'POST', `/missions/${m.id}/transitions`, {
      expectedVersion: 1,
      to: 'ready',
    });
    const added = await api.call(
      api.owner.token,
      'POST',
      `/missions/${m.id}/work-packets`,
      { expectedVersion: 2, title: 'a' },
    );
    const packetId = added.body.mission.packets[0].id as string;
    await api.call(
      api.owner.token,
      'POST',
      `/missions/${m.id}/work-packets/${packetId}/authorize`,
      { expectedVersion: 3 },
    );
    api.pool.online = [api.runner.principalId];
    await api.call(api.owner.token, 'POST', '/work/schedule');
    await reportAsRunner(api, m.id, packetId, 'succeeded');
    return { id: m.id, packetId };
  }
  const versionOf = async (api: Api, id: string) =>
    (await api.call(api.owner.token, 'GET', `/missions/${id}`)).body.mission
      .version as number;

  it('verifies, rejects and requeues through the routes', async () => {
    const api = setup();
    const { id, packetId } = await reported(api);
    const base = `/missions/${id}/work-packets/${packetId}`;

    const rejected = await api.call(api.owner.token, 'POST', `${base}/reject`, {
      expectedVersion: await versionOf(api, id),
      reason: 'no tests',
    });
    expect(rejected.status).toBe(200);
    expect(rejected.body.mission.packets[0].status).toBe('failed');

    const requeued = await api.call(
      api.owner.token,
      'POST',
      `${base}/requeue`,
      { expectedVersion: await versionOf(api, id) },
    );
    expect(requeued.body.mission.packets[0]).toMatchObject({
      status: 'pending',
      authorization: null,
    });

    const tooEarly = await api.call(api.owner.token, 'POST', `${base}/verify`, {
      expectedVersion: await versionOf(api, id),
      evidenceRefs: ['e'],
    });
    expect(tooEarly.status).toBe(409);
    expect(tooEarly.body.error.code).toBe('invalid_transition');
  });

  it('verifies a reported packet with evidence', async () => {
    const api = setup();
    const { id, packetId } = await reported(api);

    const res = await api.call(
      api.owner.token,
      'POST',
      `/missions/${id}/work-packets/${packetId}/verify`,
      { expectedVersion: await versionOf(api, id), evidenceRefs: ['ci:1'] },
    );

    expect(res.status).toBe(200);
    expect(res.body.mission.packets[0]).toMatchObject({
      status: 'verified',
      verification: { by: api.owner.principalId, evidenceRefs: ['ci:1'] },
    });
  });

  it('answers 403 self_verification when the verifier is the reporter', async () => {
    const api = setup();
    const m = await createMission(api);
    await api.call(api.cos.token, 'POST', `/missions/${m.id}/transitions`, {
      expectedVersion: 1,
      to: 'ready',
    });
    const added = await api.call(
      api.cos.token,
      'POST',
      `/missions/${m.id}/work-packets`,
      { expectedVersion: 2, title: 'a' },
    );
    const packetId = added.body.mission.packets[0].id as string;
    await api.call(
      api.cos.token,
      'POST',
      `/missions/${m.id}/work-packets/${packetId}/authorize`,
      { expectedVersion: 3, policyRefs: ['policy:1'] },
    );
    api.pool.online = [api.runner.principalId];
    await api.call(api.cos.token, 'POST', '/work/schedule');
    const mission = (await api.call(api.cos.token, 'GET', `/missions/${m.id}`))
      .body.mission;
    const cos = { id: api.cos.principalId, kind: 'chief_of_staff' as const };
    api.core.missions.reportAttempt(
      { workspaceId: 'ws_test', actor: cos },
      m.id,
      mission.version,
      mission.packets[0].activeAttemptId,
      'succeeded',
      null,
    );

    const res = await api.call(
      api.cos.token,
      'POST',
      `/missions/${m.id}/work-packets/${packetId}/verify`,
      { expectedVersion: mission.version + 1, evidenceRefs: ['e'] },
    );

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('self_verification');
  });
});

describe('error mapping for core errors', () => {
  it('maps a forbidden actor to 403', async () => {
    const db = openTestDatabase();
    const owner = seedPrincipal(db, { kind: 'human' });
    const app = createApp({ db }, [
      {
        method: 'post',
        path: '/x',
        access: { scopes: ['mission:write'] },
        handler: guarded(() => {
          throw new ForbiddenActorError('do a thing', 'runner');
        }),
      },
    ]);
    const res = await app.request('/x', {
      method: 'POST',
      headers: { authorization: `Bearer ${owner.token}` },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: {
        code: 'forbidden_actor',
        message: 'A runner principal may not do a thing',
      },
    });
  });
});

describe('search filters', () => {
  it('filters by risk, parent and intent text, and orders by recent update', async () => {
    const api = setup();
    const parent = await createMission(api, {
      ...NEW_MISSION,
      title: 'Parent',
    });
    const kid = await createMission(api, {
      ...NEW_MISSION,
      title: 'Kid',
      parentId: parent.id,
      risk: 'high',
      intent: 'unique-intent-token',
    });
    const plain = await createMission(api, { ...NEW_MISSION, title: 'Plain' });
    const titles = async (query: string) =>
      (
        await api.call(api.owner.token, 'GET', `/missions${query}`)
      ).body.items.map((i: { title: string }) => i.title);

    expect(await titles('?risk=high')).toEqual(['Kid']);
    expect(await titles(`?parentId=${parent.id}`)).toEqual(['Kid']);
    expect(await titles('?q=unique-intent')).toEqual(['Kid']);
    expect(await titles('?state=draft&risk=medium')).toEqual([
      'Plain',
      'Parent',
    ]);

    await api.call(api.owner.token, 'PATCH', `/missions/${parent.id}`, {
      expectedVersion: 1,
      title: 'Parent touched',
    });
    expect((await titles('?risk=medium'))[0]).toBe('Parent touched');
    expect(kid.id).not.toBe(plain.id);
  });
});

describe('cancel reaches nothing outside Tower', () => {
  it('makes no outbound request and clears live attempts', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const api = setup();
      const m = await createMission(api, {
        ...NEW_MISSION,
        links: [
          {
            url: 'https://github.com/o/r/issues/1',
            classification: 'required',
          },
        ],
      });
      await api.call(api.owner.token, 'POST', `/missions/${m.id}/transitions`, {
        expectedVersion: 1,
        to: 'ready',
      });
      const added = await api.call(
        api.owner.token,
        'POST',
        `/missions/${m.id}/work-packets`,
        { expectedVersion: 2, title: 'a' },
      );
      await api.call(
        api.owner.token,
        'POST',
        `/missions/${m.id}/work-packets/${added.body.mission.packets[0].id}/authorize`,
        { expectedVersion: 3 },
      );
      api.pool.online = [api.runner.principalId];
      await api.call(api.owner.token, 'POST', '/work/schedule');

      const res = await api.call(
        api.owner.token,
        'POST',
        `/missions/${m.id}/cancel`,
        {
          expectedVersion: (
            await api.call(api.owner.token, 'GET', `/missions/${m.id}`)
          ).body.mission.version,
        },
      );

      expect(res.body.mission.packets[0]).toMatchObject({
        status: 'cancelled',
        activeAttemptId: null,
      });
      expect(res.body.mission.attempts[0].status).toBe('cancelled');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
