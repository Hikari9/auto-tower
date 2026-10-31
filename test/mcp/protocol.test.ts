import { describe, expect, it } from 'vitest';
import { TOOLS } from '../../src/mcp/index.js';
import { createMcpEnv } from './setup.js';

describe('MCP transport', () => {
  it('rejects every call without a bearer token, with a challenge', async () => {
    const env = createMcpEnv();
    const reply = await env.client(undefined).rpc('ping');
    expect(reply.status).toBe(401);
    expect(reply.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('rejects an unknown or malformed token with invalid_token', async () => {
    const env = createMcpEnv();
    for (const token of ['twr_nope', 'garbage']) {
      const reply = await env.client(token).rpc('ping');
      expect(reply.status).toBe(401);
      expect(reply.headers.get('www-authenticate')).toContain(
        'error="invalid_token"',
      );
    }
  });

  it('rejects unauthenticated GET and DELETE as well', async () => {
    const env = createMcpEnv();
    for (const method of ['GET', 'DELETE']) {
      const res = await env.app.request('/mcp', { method });
      expect(res.status, method).toBe(401);
    }
  });

  it('answers a GET with 405 for an authenticated caller, since there is no stream', async () => {
    const env = createMcpEnv();
    const res = await env.http(env.owner, '/mcp');
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST, DELETE');
  });

  it('initializes, echoes a supported protocol version and opens a session', async () => {
    const env = createMcpEnv();
    const client = env.client(env.owner);
    const reply = await client.initialize('2025-03-26');
    expect(reply.status).toBe(200);
    expect(reply.body.result.protocolVersion).toBe('2025-03-26');
    expect(reply.body.result.capabilities.tools).toBeDefined();
    expect(reply.body.result.serverInfo.name).toBe('auto-tower');
    expect(client.sessionId).toMatch(/^mcs_/);
  });

  it('offers the newest version when the client asks for one Tower does not know', async () => {
    const env = createMcpEnv();
    const reply = await env.client(env.owner).initialize('1999-01-01');
    expect(reply.body.result.protocolVersion).toBe('2025-06-18');
  });

  it('answers a notification with 202 and no body', async () => {
    const env = createMcpEnv();
    const client = await env.session(env.owner);
    const reply = await client.post({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    });
    expect(reply.status).toBe(202);
    expect(reply.body).toBeUndefined();
  });

  it('refuses a batch and a non-JSON-RPC body', async () => {
    const env = createMcpEnv();
    const client = env.client(env.owner);
    const batch = await client.post([
      { jsonrpc: '2.0', id: 1, method: 'ping' },
    ]);
    expect(batch.status).toBe(400);
    const plain = await client.post({ hello: 'world' });
    expect(plain.status).toBe(400);
    expect(plain.body.error.code).toBe(-32600);
  });

  it('answers malformed JSON with a parse error', async () => {
    const env = createMcpEnv();
    const reply = await env.client(env.owner).post('{not json');
    expect(reply.status).toBe(400);
    expect(reply.body.error.code).toBe(-32700);
  });

  it('refuses an oversize body', async () => {
    const env = createMcpEnv();
    const big = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'ping',
      params: { pad: 'x'.repeat(300_000) },
    });
    const reply = await env.client(env.owner).post(big);
    expect(reply.status).toBe(413);
  });

  it('answers an unknown method and an unknown tool as protocol errors', async () => {
    const env = createMcpEnv();
    const client = await env.session(env.owner);
    expect((await client.rpc('resources/list')).body.error.code).toBe(-32601);
    const unknown = await client.rpc('tools/call', {
      name: 'delete_everything',
      arguments: {},
    });
    expect(unknown.body.error.code).toBe(-32602);
    const badArgs = await client.rpc('tools/call', {
      name: 'briefing',
      arguments: [],
    });
    expect(badArgs.body.error.code).toBe(-32602);
  });
});

describe('sessions', () => {
  it('refuses a session id that does not exist', async () => {
    const env = createMcpEnv();
    const client = env.client(env.owner, { 'mcp-session-id': 'mcs_missing' });
    const reply = await client.rpc('tools/list');
    expect(reply.status).toBe(404);
  });

  it("refuses another principal's session id as if it were unknown", async () => {
    const env = createMcpEnv();
    const mine = await env.session(env.owner);
    const theirs = env.client(env.cos, {
      'mcp-session-id': mine.sessionId ?? '',
    });
    expect((await theirs.rpc('tools/list')).status).toBe(404);
    expect((await mine.rpc('tools/list')).status).toBe(200);
  });

  it('ends a session on DELETE and refuses it afterwards', async () => {
    const env = createMcpEnv();
    const client = await env.session(env.owner);
    const res = await env.http(env.owner, '/mcp', {
      method: 'DELETE',
      headers: { 'mcp-session-id': client.sessionId ?? '' },
    });
    expect(res.status).toBe(204);
    expect((await client.rpc('tools/list')).status).toBe(404);
    const again = await env.http(env.owner, '/mcp', {
      method: 'DELETE',
      headers: { 'mcp-session-id': client.sessionId ?? '' },
    });
    expect(again.status).toBe(404);
  });

  it('does not let one principal close the session of another', async () => {
    const env = createMcpEnv();
    const mine = await env.session(env.owner);
    const res = await env.http(env.cos, '/mcp', {
      method: 'DELETE',
      headers: { 'mcp-session-id': mine.sessionId ?? '' },
    });
    expect(res.status).toBe(404);
    expect((await mine.rpc('tools/list')).status).toBe(200);
  });

  it('works without a session for a client that never initializes', async () => {
    const env = createMcpEnv();
    const reply = await env.client(env.owner).rpc('tools/list');
    expect(reply.status).toBe(200);
  });
});

describe('origin policy', () => {
  it('refuses a browser origin nobody allowed, and accepts a listed one', async () => {
    const env = createMcpEnv({
      mcp: { allowedOrigins: ['https://chat.example.test'] },
    });
    const bad = await env
      .client(env.owner, { origin: 'https://evil.example.test' })
      .rpc('ping');
    expect(bad.status).toBe(403);
    const good = await env
      .client(env.owner, { origin: 'https://chat.example.test' })
      .rpc('ping');
    expect(good.status).toBe(200);
  });

  it('applies the same origin policy to GET and DELETE, leaving the session open', async () => {
    const env = createMcpEnv({
      mcp: { allowedOrigins: ['https://chat.example.test'] },
    });
    const s = await env.session(env.owner);
    for (const method of ['GET', 'DELETE']) {
      const bad = await env.http(env.owner, '/mcp', {
        method,
        headers: {
          origin: 'https://evil.example.test',
          'mcp-session-id': s.sessionId ?? '',
        },
      });
      expect(bad.status, method).toBe(403);
    }
    expect((await s.rpc('tools/list')).status).toBe(200);
    const good = await env.http(env.owner, '/mcp', {
      method: 'GET',
      headers: { origin: 'https://chat.example.test' },
    });
    expect(good.status).toBe(405);
    const ended = await env.http(env.owner, '/mcp', {
      method: 'DELETE',
      headers: {
        origin: 'https://chat.example.test',
        'mcp-session-id': s.sessionId ?? '',
      },
    });
    expect(ended.status).toBe(204);
  });

  it('refuses any origin by default, before looking at the credential', async () => {
    const env = createMcpEnv();
    const reply = await env
      .client(undefined, { origin: 'http://localhost:3000' })
      .rpc('ping');
    expect(reply.status).toBe(403);
  });
});

describe('tool declarations', () => {
  it('declares read-only or mutating and a required scope on every tool', () => {
    for (const tool of TOOLS) {
      expect(typeof tool.readOnly, tool.name).toBe('boolean');
      expect(tool.scopes.length, tool.name).toBeGreaterThan(0);
      if (tool.readOnly) {
        expect(
          tool.scopes.every((s) => s.endsWith(':read')),
          tool.name,
        ).toBe(true);
        expect(tool.material, tool.name).toBeUndefined();
      }
    }
  });

  it('covers every tool spec J names', () => {
    const names = TOOLS.map((t) => t.name);
    for (const name of [
      'create_mission',
      'search_missions',
      'read_mission',
      'update_mission',
      'list_runners',
      'list_runs',
      'list_decisions',
      'answer_decision',
      'propose_policy_change',
      'grant_policy',
      'revoke_policy',
      'preview_dispatch',
      'request_dispatch',
      'inspect_evidence',
      'request_reconciliation',
      'recent_activity',
      'briefing',
    ]) {
      expect(names, name).toContain(name);
    }
  });

  it('makes every action that grants, revokes, dispatches, closes or authorizes work material, and nothing else', () => {
    const material = TOOLS.filter((t) => t.material === true)
      .map((t) => t.name)
      .sort();
    expect(material).toEqual([
      'answer_decision',
      'close_mission',
      'grant_policy',
      'request_dispatch',
      'request_expansion',
      'request_reconciliation',
      'revoke_policy',
      'set_feature_flag',
    ]);
  });

  it('publishes the declarations in tools/list, and lists only what the caller may call', async () => {
    const env = createMcpEnv();
    const human = await env.session(env.owner);
    const listed = (await human.rpc('tools/list')).body.result.tools;
    expect(listed.length).toBe(TOOLS.length);
    const grant = listed.find(
      (t: { name: string }) => t.name === 'grant_policy',
    );
    expect(grant.annotations.readOnlyHint).toBe(false);
    expect(grant.annotations.destructiveHint).toBe(true);
    expect(grant._meta['tower/requiredScopes']).toEqual(['policy:write']);
    expect(grant.inputSchema.required).toEqual(
      expect.arrayContaining(['idempotencyKey', 'confirm']),
    );
    const brief = listed.find((t: { name: string }) => t.name === 'briefing');
    expect(brief.annotations.readOnlyHint).toBe(true);
    expect(brief.inputSchema.properties.idempotencyKey).toBeUndefined();

    const cos = await env.session(env.cos);
    const cosTools = (await cos.rpc('tools/list')).body.result.tools.map(
      (t: { name: string }) => t.name,
    );
    expect(cosTools).toContain('create_mission');
    expect(cosTools).not.toContain('grant_policy');
    expect(cosTools).not.toContain('list_runners');
  });
});
