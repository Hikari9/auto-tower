import { describe, expect, it } from 'vitest';
import { missionForViewer } from '../../src/fleet/broker.js';
import { createPolicyService } from '../../src/policy/service.js';
import { mission } from '../core/helpers.js';
import { createIssueApi, type IssueApi } from '../issues/helpers.js';
import { McpClient } from '../mcp/helpers.js';
import { ruleInput } from '../policy/helpers.js';

/** A mission with one packet a chief of staff authorized under a rule, so it carries a policy ref. */
function citedMission(api: IssueApi) {
  const { h } = api;
  const policy = createPolicyService({ db: h.db, clock: h.clock.now });
  const rule = policy.createRule(h.ctx(), ruleInput()).rule;
  const ref = `policy:v${policy.policyVersion('ws_test')}:rule:${rule.id}@1`;
  // The mission cites the ref too, so mission.created carries it in its payload.
  let state = h.core.missions.createMission(
    h.ctx(),
    mission({ policyRefs: [ref] }),
  ).mission;
  state = h.core.missions.transitionMission(
    h.ctx(),
    state.id,
    state.version,
    'ready',
    null,
  ).mission;
  state = h.core.missions.addPacket(h.ctx(), state.id, state.version, {
    title: 'cited',
    instructions: 'do it',
    scope: ['env:staging'],
    required: true,
    dependsOn: [],
  }).mission;
  const packetId = state.packets[0]?.id as string;
  state = h.core.missions.authorizePacket(
    h.ctx(h.cos),
    state.id,
    state.version,
    packetId,
    [ref],
  ).mission;
  return { id: state.id, ref, ruleId: rule.id, packetId };
}

async function readOverMcp(api: IssueApi, token: string, missionId: string) {
  const client = new McpClient((path, init) => api.raw(path, init), token);
  await client.initialize();
  const reply = await client.call('read_mission', { missionId });
  expect(reply.isError).toBe(false);
  return reply;
}

describe('a mission read hides policy refs from non-human viewers', () => {
  it('shows a runner and a provider no rule id or policy ref over HTTP, and a person the refs', async () => {
    const api = createIssueApi();
    const m = citedMission(api);
    for (const token of [api.runner, api.provider]) {
      const res = await api.call(token, 'GET', `/missions/${m.id}`);
      expect(res.status).toBe(200);
      const text = JSON.stringify(res.body);
      expect(text).not.toContain('rul_');
      expect(text).not.toContain('policy:v');
      // The packet is still readable, with the same shape and only its refs replaced.
      const packet = res.body.mission.packets[0];
      expect(packet.id).toBe(m.packetId);
      expect(packet.authorization.policyRefs).toEqual(['[redacted]']);
    }
    for (const token of [api.owner, api.cos]) {
      const res = await api.call(token, 'GET', `/missions/${m.id}`);
      expect(res.body.mission.packets[0].authorization.policyRefs).toEqual([
        m.ref,
      ]);
    }
  });

  it('hides the refs on the packet list too, and shows them to a person', async () => {
    const api = createIssueApi();
    const m = citedMission(api);
    for (const token of [api.runner, api.provider]) {
      const res = await api.call(
        token,
        'GET',
        `/missions/${m.id}/work-packets`,
      );
      expect(res.status).toBe(200);
      const text = JSON.stringify(res.body);
      expect(text).not.toContain('rul_');
      expect(text).not.toContain('policy:v');
      expect(res.body.packets[0].authorization.policyRefs).toEqual([
        '[redacted]',
      ]);
    }
    for (const token of [api.owner, api.cos]) {
      const res = await api.call(
        token,
        'GET',
        `/missions/${m.id}/work-packets`,
      );
      expect(res.body.packets[0].authorization.policyRefs).toEqual([m.ref]);
    }
  });

  it('shows a runner and a provider no rule id or policy ref over MCP, and a person the refs', async () => {
    const api = createIssueApi();
    const m = citedMission(api);
    for (const token of [api.runner, api.provider]) {
      const reply = await readOverMcp(api, token, m.id);
      const text = JSON.stringify(reply.reply.body);
      expect(text).not.toContain('rul_');
      expect(text).not.toContain('policy:v');
      expect(reply.data.mission.packets[0].authorization.policyRefs).toEqual([
        '[redacted]',
      ]);
    }
    for (const token of [api.owner, api.cos]) {
      const reply = await readOverMcp(api, token, m.id);
      expect(reply.data.mission.packets[0].authorization.policyRefs).toEqual([
        m.ref,
      ]);
    }
  });

  it('redacts the refs a mission itself carries, and leaves a person the mission whole', () => {
    const api = createIssueApi();
    const m = citedMission(api);
    const stored = api.h.core.missions.getMission('ws_test', m.id);
    expect(stored).toBeDefined();
    const withRefs = {
      ...(stored as NonNullable<typeof stored>),
      policyRefs: [m.ref],
    };
    for (const viewer of ['runner', 'provider_adapter'] as const) {
      const seen = missionForViewer(withRefs, viewer);
      expect(seen.policyRefs).toEqual(['[redacted]']);
      expect(JSON.stringify(seen)).not.toContain('policy:v');
    }
    expect(missionForViewer(withRefs, 'human')).toBe(withRefs);
    expect(missionForViewer(withRefs, 'chief_of_staff')).toBe(withRefs);
  });

  it('hides refs and rule ids from the activity route and recent_activity for a runner and a provider', async () => {
    const api = createIssueApi();
    const m = citedMission(api);
    const routeOf = (token: string) =>
      api.call(token, 'GET', `/missions/${m.id}/activity`);
    const toolOf = async (token: string) => {
      const client = new McpClient((path, init) => api.raw(path, init), token);
      await client.initialize();
      const reply = await client.call('recent_activity', { missionId: m.id });
      expect(reply.isError).toBe(false);
      return reply;
    };

    // A person still sees the refs, on the items and in the mission.created payload.
    for (const token of [api.owner, api.cos]) {
      const route = await routeOf(token);
      const tool = await toolOf(token);
      for (const items of [route.body.items, tool.data.items]) {
        const created = items.find(
          (i: { type: string }) => i.type === 'mission.created',
        );
        expect(created.payload.policyRefs).toEqual([m.ref]);
        const authorized = items.find(
          (i: { type: string }) => i.type === 'packet.authorized',
        );
        expect(authorized.policyRefs).toEqual([m.ref]);
      }
    }

    for (const token of [api.runner, api.provider]) {
      const route = await routeOf(token);
      expect(route.status).toBe(200);
      const tool = await toolOf(token);
      for (const [text, items] of [
        [JSON.stringify(route.body), route.body.items],
        [JSON.stringify(tool.reply.body), tool.data.items],
      ] as const) {
        expect(text).not.toContain('rul_');
        expect(text).not.toContain('policy:v');
        expect(items.length).toBeGreaterThan(1);
        for (const item of items) {
          expect(item).not.toHaveProperty('policyRefs');
          expect(item.payload ?? {}).not.toHaveProperty('policyRefs');
        }
        // The events are still there, with their types and versions.
        expect(items.map((i: { type: string }) => i.type)).toContain(
          'packet.authorized',
        );
      }
    }
  });

  it('hides rule ids written into activity payload strings from a runner', async () => {
    const api = createIssueApi();
    const m = citedMission(api);
    api.h.core.missions.getMission('ws_test', m.id);
    const version = (
      api.h.core.missions.getMission('ws_test', m.id) as { version: number }
    ).version;
    api.h.core.missions.updateMission(api.h.ctx(), m.id, version, {
      title: `reuses ${m.ruleId} and ${m.ref}`,
    });
    const owner = await api.call(
      api.owner,
      'GET',
      `/missions/${m.id}/activity`,
    );
    expect(JSON.stringify(owner.body)).toContain(m.ruleId);
    const runner = await api.call(
      api.runner,
      'GET',
      `/missions/${m.id}/activity`,
    );
    const text = JSON.stringify(runner.body);
    expect(text).not.toContain('rul_');
    expect(text).not.toContain('policy:v');
    expect(text).toContain('a policy rule');
  });

  it('shows a runner no rule id or policy ref from any mission:read route or tool', async () => {
    const api = createIssueApi();
    const m = citedMission(api);
    const routes = [
      '/missions',
      `/missions/${m.id}`,
      `/missions/${m.id}/activity`,
      `/missions/${m.id}/work-packets`,
      `/missions/${m.id}/issue-links`,
      `/missions/${m.id}/issue-links/history`,
      `/missions/${m.id}/issue-discrepancies`,
      '/issues/sync-config',
    ];
    for (const token of [api.runner, api.provider]) {
      for (const path of routes) {
        const res = await api.call(token, 'GET', path);
        expect(res.status, path).toBe(200);
        const text = JSON.stringify(res.body);
        expect(text, path).not.toContain('rul_');
        expect(text, path).not.toContain('policy:v');
      }
    }
    const tools: [string, Record<string, unknown>][] = [
      ['briefing', {}],
      ['recent_activity', {}],
      ['recent_activity', { missionId: m.id }],
      ['search_missions', {}],
      ['read_mission', { missionId: m.id }],
      ['preview_dispatch', { missionId: m.id }],
      ['inspect_evidence', { missionId: m.id }],
      ['list_runs', { missionId: m.id }],
    ];
    for (const token of [api.runner, api.provider]) {
      const client = new McpClient((path, init) => api.raw(path, init), token);
      await client.initialize();
      for (const [name, args] of tools) {
        const reply = await client.call(name, args);
        expect(reply.isError, name).toBe(false);
        const text = JSON.stringify(reply.reply.body);
        expect(text, name).not.toContain('rul_');
        expect(text, name).not.toContain('policy:v');
      }
    }
  });

  it('hides rule ids from the reason a preview_dispatch gives a runner, and shows them to a chief of staff', async () => {
    const api = createIssueApi();
    const m = citedMission(api);
    const current = api.h.core.missions.getMission('ws_test', m.id) as {
      version: number;
    };
    const added = api.h.core.missions.addPacket(
      api.h.ctx(),
      m.id,
      current.version,
      {
        title: 'second',
        instructions: 'do it',
        scope: ['env:production'],
        required: true,
        dependsOn: [],
      },
    ).mission;
    const packetId = added.packets[1]?.id as string;
    const args = { missionId: m.id, packetId, policyRefs: [m.ref] };
    const reasonFor = async (token: string) => {
      const client = new McpClient((path, init) => api.raw(path, init), token);
      await client.initialize();
      const reply = await client.call('preview_dispatch', args);
      expect(reply.isError).toBe(false);
      return reply.data.packets[0].citedPolicy;
    };
    const cos = await reasonFor(api.cos);
    expect(cos.accepted).toBe(false);
    expect(cos.reason).toContain(m.ruleId);
    for (const token of [api.runner, api.provider]) {
      const cited = await reasonFor(token);
      expect(cited.accepted).toBe(false);
      expect(cited.reason).not.toContain('rul_');
      expect(cited.reason).not.toContain('policy:v');
    }
  });
});
