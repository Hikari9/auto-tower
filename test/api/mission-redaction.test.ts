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
  let state = h.core.missions.createMission(h.ctx(), mission()).mission;
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
  const rule = policy.createRule(h.ctx(), ruleInput()).rule;
  const ref = `policy:v${policy.policyVersion('ws_test')}:rule:${rule.id}@1`;
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
});
