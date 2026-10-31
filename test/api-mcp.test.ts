import { describe, expect, it } from 'vitest';
import { createApi } from '../src/http/api.ts';
import { makeHarness, simpleMission } from './harness.ts';

async function setup() {
  const h = await makeHarness();
  const api = createApi(h.tower);
  const call = async (method: string, path: string, token: string | null, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await api(
      new Request(`http://tower.test${path}`, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', ...headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
    );
    return { status: res.status, body: (await res.json()) as any, headers: res.headers };
  };
  let rpcId = 0;
  const mcp = async (token: string, method: string, params: unknown = {}) => (await call('POST', '/mcp', token, { jsonrpc: '2.0', id: ++rpcId, method, params })).body;
  const tool = async (token: string, name: string, args: unknown) => (await mcp(token, 'tools/call', { name, arguments: args })).result;
  return { h, api, call, mcp, tool };
}

describe('HTTP API and MCP seam', () => {
  it('denies unauthenticated and revoked callers on every surface', async () => {
    const { h, call } = await setup();
    expect((await call('GET', '/api/v1/missions', null)).status).toBe(401);
    expect((await call('GET', '/api/v1/missions', 'twr_h_nope')).status).toBe(401);
    expect((await call('POST', '/mcp', null, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(401);
    expect((await call('GET', '/healthz', null)).status).toBe(200);
    await h.tower.admin.revokePrincipal(h.owner, h.chief.principal.id);
    expect((await call('GET', '/api/v1/missions', h.chiefToken)).status).toBe(401);
  });

  it('separates principal scopes: runners cannot read missions or grant, chiefs cannot grant', async () => {
    const { h, call } = await setup();
    const r = await h.tower.admin.issueToken(h.owner, { kind: 'runner', name: 'r', scopes: ['admin', 'policy:grant', 'missions:read'] });
    expect(r.scopes).toEqual([]);
    expect((await call('GET', '/api/v1/missions', r.token)).status).toBe(403);
    expect((await call('POST', '/api/v1/policy/rules', r.token, { action: 'a', resource: 'b' })).status).toBe(403);
    expect((await call('POST', '/api/v1/policy/rules', h.chiefToken, { action: 'a', resource: 'b' })).status).toBe(403);
    expect((await call('POST', '/api/v1/admin/tokens', h.chiefToken, { kind: 'chief', name: 'x' })).status).toBe(403);
    const c = await h.tower.admin.issueToken(h.owner, { kind: 'chief', name: 'c2', scopes: ['policy:grant', 'missions:read'] });
    expect(c.scopes).toEqual(['missions:read']);
  });

  it('validates input, returns correlation ids, and supports idempotency keys', async () => {
    const { h, call } = await setup();
    const bad = await call('POST', '/api/v1/missions', h.ownerToken, { title: '' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid');
    const a = await call('POST', '/api/v1/missions', h.ownerToken, simpleMission(), { 'idempotency-key': 'k1', 'x-correlation-id': 'corr-123' });
    expect(a.status).toBe(200);
    expect(a.headers.get('x-correlation-id')).toBe('corr-123');
    const b = await call('POST', '/api/v1/missions', h.ownerToken, simpleMission(), { 'idempotency-key': 'k1' });
    expect(b.body.id).toBe(a.body.id);
    const ev = await h.tower.repo.events(h.workspaceId, { missionId: a.body.id, afterSeq: 0 });
    expect(ev[0]!.correlationId).toBe('corr-123');
  });

  it('a mission created through MCP survives the chat: visible to the dashboard API and a second chat', async () => {
    const { h, mcp, tool, call } = await setup();
    const init = await mcp(h.ownerToken, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'chatgpt', version: '1' } });
    expect(init.result.protocolVersion).toBe('2025-06-18');
    expect(init.result.capabilities.tools).toBeDefined();
    const list = await mcp(h.ownerToken, 'tools/list');
    const names = list.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(['tower_briefing', 'mission_create', 'decision_answer', 'policy_grant', 'policy_propose']));
    const createTool = list.result.tools.find((t: { name: string }) => t.name === 'mission_create');
    expect(createTool.annotations.readOnlyHint).toBe(false);
    expect(createTool.inputSchema.type).toBe('object');
    const created = await tool(h.ownerToken, 'mission_create', { ...simpleMission(), idempotencyKey: 'chat-1' });
    expect(created.isError).toBeUndefined();
    const id = created.structuredContent.result.id;
    // "Close the chat": a fresh client session (no shared state) and the dashboard API both see it.
    const second = await tool(h.chiefToken, 'mission_get', { missionId: id });
    expect(second.structuredContent.result.mission.title).toBe('Ship feature X');
    expect((await call('GET', `/api/v1/missions/${id}`, h.ownerToken)).body.mission.id).toBe(id);
    const brief = await tool(h.chiefToken, 'tower_briefing', {});
    expect(brief.structuredContent.result.missions[0].activity).toBe('waiting_runner');
  });

  it('hides owner-only tools from a chief and requires confirmation for material changes', async () => {
    const { h, mcp, tool } = await setup();
    const chiefTools = (await mcp(h.chiefToken, 'tools/list')).result.tools.map((t: { name: string }) => t.name);
    expect(chiefTools).not.toContain('policy_grant');
    expect(chiefTools).toContain('policy_propose');
    expect((await mcp(h.chiefToken, 'tools/call', { name: 'policy_grant', arguments: { action: 'a', resource: 'b' } })).error.code).toBe(-32602);
    const args = { action: 'deploy.preview', resource: 'env:preview/*', grantee: 'chief' };
    const preview = await tool(h.ownerToken, 'policy_grant', args);
    expect(preview.structuredContent.confirmationRequired).toBe(true);
    expect((await h.tower.policy.list(h.owner)).rules).toHaveLength(0);
    const wrong = await tool(h.ownerToken, 'policy_grant', { ...args, resource: '*', confirm: preview.structuredContent.confirm });
    expect(wrong.structuredContent.confirmationRequired).toBe(true);
    const done = await tool(h.ownerToken, 'policy_grant', { ...args, confirm: preview.structuredContent.confirm });
    expect(done.structuredContent.result.action).toBe('deploy.preview');
    const proposal = await tool(h.chiefToken, 'policy_propose', { action: 'deploy.preview', resource: 'env:preview/x' });
    expect(proposal.structuredContent.result.status).toBe('pending');
  });

  it('reports tool errors as MCP tool errors, not transport errors', async () => {
    const { h, tool } = await setup();
    const r = await tool(h.ownerToken, 'mission_get', { missionId: 'msn_missing' });
    expect(r.isError).toBe(true);
    expect(r.structuredContent.error.code).toBe('not_found');
    const v = await tool(h.ownerToken, 'mission_create', { title: 3 });
    expect(v.isError).toBe(true);
  });

  it('rate-limits a principal that floods the API', async () => {
    const h = await makeHarness();
    const api = createApi(h.tower, { ratePerMinute: 5 });
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await api(new Request('http://t/api/v1/missions', { headers: { authorization: `Bearer ${h.ownerToken}` } }))).status);
    expect(statuses.slice(0, 5).every((s) => s === 200)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});
