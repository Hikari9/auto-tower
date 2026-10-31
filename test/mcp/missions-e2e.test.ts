import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import {
  openTestDatabase,
  seedPrincipal,
  tempDbPath,
} from '../helpers/tower.js';
import { key } from './helpers.js';
import { createMcpEnv, MISSION } from './setup.js';

describe('a mission over MCP', () => {
  it('is created in session A, closed, and read the same in session B and over HTTP', async () => {
    const env = createMcpEnv();
    const a = await env.session(env.owner);
    const b = await env.session(env.owner);
    expect(a.sessionId).not.toBe(b.sessionId);

    const created = await a.ok('create_mission', {
      ...MISSION,
      idempotencyKey: key(),
    });
    const id: string = created.mission.id;
    expect(created.mission.state).toBe('draft');
    expect(created.mission.createdBy).toBe(env.principals.owner);

    const closed = await a.ok('close_mission', {
      missionId: id,
      expectedVersion: created.mission.version,
      outcome: 'cancelled',
      reason: 'not needed',
      idempotencyKey: key(),
      confirm: true,
    });
    expect(closed.mission.state).toBe('cancelled');

    const viaB = (await b.ok('read_mission', { missionId: id })).mission;
    const viaHttp = (
      (await (await env.http(env.owner, `/missions/${id}`)).json()) as {
        mission: unknown;
      }
    ).mission;
    expect(viaB.state).toBe('cancelled');
    expect(viaB).toEqual(closed.mission);
    expect(viaB).toEqual(viaHttp);

    const found = await b.ok('search_missions', {
      q: 'Ship',
      state: ['cancelled'],
    });
    expect(found.items.map((m: { id: string }) => m.id)).toEqual([id]);

    const activity = await b.ok('recent_activity', { missionId: id });
    expect(activity.items.map((e: { type: string }) => e.type)).toEqual([
      'mission.created',
      'mission.transitioned',
    ]);
    const recent = await b.ok('recent_activity', { limit: 5 });
    expect(recent.items[0]).toMatchObject({
      missionId: id,
      type: 'mission.transitioned',
    });
  });

  it('shows a mission created over HTTP to MCP and the reverse', async () => {
    const env = createMcpEnv();
    const s = await env.session(env.cos);
    const res = await env.http(env.cos, '/missions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(MISSION),
    });
    const { mission } = (await res.json()) as { mission: { id: string } };
    expect(
      (await s.ok('read_mission', { missionId: mission.id })).mission.id,
    ).toBe(mission.id);
  });

  it('survives a server restart on the same SQLite file, sessions included', async () => {
    const path = tempDbPath();
    const first = createMcpEnv({ db: openTestDatabase(path) });
    const a = await first.session(first.owner);
    const created = await a.ok('create_mission', {
      ...MISSION,
      idempotencyKey: 'persist-1',
    });
    const sessionId = a.sessionId ?? '';
    const token = first.owner;
    first.db.close();

    const db = openTestDatabase(path);
    const app = createApp({ db });
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'read_mission',
          arguments: { missionId: created.mission.id },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { structuredContent: { mission: { id: string; title: string } } };
    };
    expect(body.result.structuredContent.mission).toMatchObject({
      id: created.mission.id,
      title: MISSION.title,
    });

    // A retried create after the restart returns the first result instead of a second mission.
    const retry = await app.request('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'create_mission',
          arguments: { ...MISSION, idempotencyKey: 'persist-1' },
        },
      }),
    });
    const retried = (await retry.json()) as {
      result: { structuredContent: { mission: { id: string } } };
    };
    expect(retried.result.structuredContent.mission.id).toBe(
      created.mission.id,
    );
    db.close();
  });

  it('updates a mission with a stale version refused and a lowered risk refused for a chief of staff', async () => {
    const env = createMcpEnv();
    const owner = await env.session(env.owner);
    const cos = await env.session(env.cos);
    const created = await owner.ok('create_mission', {
      ...MISSION,
      risk: 'high',
      idempotencyKey: key(),
    });
    const id = created.mission.id;
    const stale = await owner.call('update_mission', {
      missionId: id,
      expectedVersion: 99,
      title: 'x',
      idempotencyKey: key(),
    });
    expect(stale.data.error.code).toBe('version_conflict');
    const lowered = await cos.call('update_mission', {
      missionId: id,
      expectedVersion: 1,
      risk: 'low',
      idempotencyKey: key(),
    });
    expect(lowered.data.error.code).toBe('risk_lowering_refused');
    const receipt = env.db.get<{ code: string }>(
      "SELECT code FROM policy_receipts WHERE action = 'mission.risk.lower'",
    );
    expect(receipt?.code).toBe('risk_lowering_refused');
    const ok = await owner.ok('update_mission', {
      missionId: id,
      expectedVersion: 1,
      title: 'Renamed',
      idempotencyKey: key(),
    });
    expect(ok.mission.title).toBe('Renamed');
  });

  it('answers not-found the same for a missing mission and another workspace', async () => {
    const env = createMcpEnv();
    const s = await env.session(env.owner);
    const created = await s.ok('create_mission', {
      ...MISSION,
      idempotencyKey: key(),
    });
    // A second workspace's human cannot read it.
    const foreign = seedPrincipal(env.db, {
      kind: 'human',
      workspaceId: 'ws_other',
    });
    const f = await env.session(foreign.token);
    const miss = await f.call('read_mission', {
      missionId: created.mission.id,
    });
    const none = await s.call('read_mission', { missionId: 'msn_nope' });
    expect(miss.data.error.code).toBe('mission_not_found');
    expect(none.data.error.code).toBe('mission_not_found');
    expect((await f.ok('search_missions')).total).toBe(0);
  });
});
