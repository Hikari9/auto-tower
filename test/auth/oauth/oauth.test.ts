import { describe, expect, it } from 'vitest';
import { createApp } from '../../../src/api/app.js';
import {
  bearerChallenge,
  resourceUrls,
} from '../../../src/auth/oauth/challenge.js';
import {
  linkIdentity,
  revokeIdentity,
} from '../../../src/auth/oauth/identity.js';
import { openTestDatabase, seedPrincipal } from '../../helpers/tower.js';
import { appRequester, McpClient } from '../../mcp/helpers.js';
import { createMcpEnv } from '../../mcp/setup.js';
import {
  BASE_URL,
  FakeAuthProvider,
  ISSUER,
  RESOURCE,
} from './fake-provider.js';

const METADATA = `${BASE_URL}/.well-known/oauth-protected-resource/mcp`;

function setup() {
  const provider = new FakeAuthProvider();
  const env = createMcpEnv({
    mcp: { publicBaseUrl: BASE_URL, authProvider: provider },
  });
  return { provider, env };
}

describe('protected resource metadata', () => {
  it('publishes the RFC 9728 document at the root and path-suffixed locations', async () => {
    const { env } = setup();
    for (const path of [
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-protected-resource/mcp',
    ]) {
      const res = await env.app.request(path);
      expect(res.status, path).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        resource: RESOURCE,
        authorization_servers: [ISSUER],
        bearer_methods_supported: ['header'],
      });
      expect(body.scopes_supported).toEqual(
        expect.arrayContaining(['mission:read', 'policy:write']),
      );
    }
  });

  it('needs no credential, and holds no secret or Tower token', async () => {
    const { env } = setup();
    const text = await (
      await env.app.request('/.well-known/oauth-protected-resource')
    ).text();
    expect(text).not.toMatch(/twr_|secret|token_hash/i);
  });

  it('is not published when no provider or public URL is configured', async () => {
    const none = createMcpEnv();
    expect(
      (await none.app.request('/.well-known/oauth-protected-resource')).status,
    ).toBe(404);
    const onlyUrl = createMcpEnv({ mcp: { publicBaseUrl: BASE_URL } });
    expect(
      (await onlyUrl.app.request('/.well-known/oauth-protected-resource/mcp'))
        .status,
    ).toBe(404);
  });

  it('never builds a URL from request headers', async () => {
    const { env } = setup();
    const res = await env.app.request('/.well-known/oauth-protected-resource', {
      headers: {
        host: 'evil.example.test',
        'x-forwarded-host': 'evil.example.test',
      },
    });
    expect(JSON.stringify(await res.json())).not.toContain('evil');
  });
});

describe('WWW-Authenticate challenges', () => {
  it('points an unauthenticated client at the metadata', async () => {
    const { env } = setup();
    const reply = await env.client(undefined).rpc('ping');
    expect(reply.status).toBe(401);
    expect(reply.headers.get('www-authenticate')).toBe(
      `Bearer resource_metadata="${METADATA}"`,
    );
  });

  it('adds error="invalid_token" for a token that does not verify', async () => {
    const { env } = setup();
    const reply = await env.client('not-a-token').rpc('ping');
    expect(reply.headers.get('www-authenticate')).toBe(
      `Bearer error="invalid_token", resource_metadata="${METADATA}"`,
    );
  });

  it('names the missing scope on a 403, with the metadata', async () => {
    const { env, provider } = setup();
    const human = env.seed('human');
    linkIdentity(env.db, {
      issuer: ISSUER,
      subject: 'alice',
      principalId: human.principalId,
      linkedBy: human.principalId,
    });
    const token = provider.mint('at-1', {
      subject: 'alice',
      scopes: ['mission:read'],
    });
    const s = await env.session(token);
    const reply = await s.call('create_mission', {
      title: 't',
      intent: 'i',
      outcome: 'o',
      idempotencyKey: 'k1',
    });
    expect(reply.status).toBe(403);
    expect(reply.reply.headers.get('www-authenticate')).toBe(
      `Bearer error="insufficient_scope", scope="mission:write", resource_metadata="${METADATA}"`,
    );
  });

  it('escapes quotes in challenge parameters', () => {
    expect(
      bearerChallenge({ error: 'invalid_token', description: 'a "b" \\ c' }),
    ).toBe(
      'Bearer error="invalid_token", error_description="a \\"b\\" \\\\ c"',
    );
    expect(bearerChallenge()).toBe('Bearer');
  });
});

describe('provider access tokens', () => {
  function linked(scopes?: Parameters<typeof linkIdentity>[1]['scopes']) {
    const ctx = setup();
    const human = ctx.env.seed('human');
    linkIdentity(ctx.env.db, {
      issuer: ISSUER,
      subject: 'alice',
      principalId: human.principalId,
      linkedBy: human.principalId,
      scopes,
    });
    return { ...ctx, human };
  }

  it('authenticates a linked identity as its Tower principal, and the principal owns what it writes', async () => {
    const { env, provider, human } = linked();
    const token = provider.mint('at-ok', {
      subject: 'alice',
      scopes: ['mission:read', 'mission:write'],
    });
    const s = await env.session(token);
    const created = await s.ok('create_mission', {
      title: 't',
      intent: 'i',
      outcome: 'o',
      idempotencyKey: 'k',
    });
    expect(created.mission.createdBy).toBe(human.principalId);
  });

  it('refuses a token minted for another resource', async () => {
    const { env, provider } = linked();
    provider.mint('at-aud', {
      subject: 'alice',
      audience: ['https://other.example.test/mcp'],
    });
    expect((await env.client('at-aud').rpc('ping')).status).toBe(401);
    provider.mint('at-noaud', { subject: 'alice', audience: [] });
    expect((await env.client('at-noaud').rpc('ping')).status).toBe(401);
  });

  it('refuses an expired token and one from an issuer the provider does not list', async () => {
    const { env, provider } = linked();
    provider.mint('at-old', {
      subject: 'alice',
      expiresAt: new Date('2000-01-01T00:00:00Z'),
    });
    provider.mint('at-iss', {
      subject: 'alice',
      issuer: 'https://evil.example.test',
    });
    expect((await env.client('at-old').rpc('ping')).status).toBe(401);
    expect((await env.client('at-iss').rpc('ping')).status).toBe(401);
  });

  it('refuses a valid token for an identity nobody linked', async () => {
    const { env, provider } = setup();
    provider.mint('at-stranger', { subject: 'stranger' });
    expect((await env.client('at-stranger').rpc('ping')).status).toBe(401);
  });

  it('stops honouring a revoked link and a disabled principal at once', async () => {
    const { env, provider, human } = linked();
    provider.mint('at-1', { subject: 'alice' });
    expect((await env.client('at-1').rpc('ping')).status).toBe(200);
    env.db.run('UPDATE principals SET disabled_at = ? WHERE id = ?', [
      '2026-01-01T00:00:00Z',
      human.principalId,
    ]);
    expect((await env.client('at-1').rpc('ping')).status).toBe(401);
    env.db.run('UPDATE principals SET disabled_at = NULL WHERE id = ?', [
      human.principalId,
    ]);
    revokeIdentity(env.db, ISSUER, 'alice');
    expect((await env.client('at-1').rpc('ping')).status).toBe(401);
  });

  it('cuts scopes to what the provider granted, the link allows and the principal kind may hold', async () => {
    const { env, provider } = linked(['mission:read', 'mission:write']);
    provider.mint('at-wide', {
      subject: 'alice',
      scopes: ['mission:read', 'policy:write', 'admin:tokens', 'made:up'],
    });
    const s = await env.session('at-wide');
    const names = (await s.rpc('tools/list')).body.result.tools.map(
      (t: { name: string }) => t.name,
    );
    expect(names).toContain('search_missions');
    expect(names).not.toContain('create_mission');
    expect(names).not.toContain('grant_policy');
  });

  it('applies the principal kind ceiling at use time to a link row written directly', async () => {
    const { env, provider } = setup();
    const cos = env.seed('chief_of_staff');
    env.db.run(
      `INSERT INTO oauth_identities (workspace_id, issuer, subject, principal_id, scopes_json, linked_by, linked_at)
       VALUES ('ws_test', ?, 'dave', ?, ?, ?, '2026-01-01T00:00:00Z')`,
      [
        ISSUER,
        cos.principalId,
        JSON.stringify(['mission:read', 'policy:write']),
        env.principals.owner,
      ],
    );
    provider.mint('at-d', {
      subject: 'dave',
      scopes: ['mission:read', 'policy:write'],
    });
    const s = await env.session('at-d');
    const names = (await s.rpc('tools/list')).body.result.tools.map(
      (t: { name: string }) => t.name,
    );
    expect(names).toContain('search_missions');
    expect(names).not.toContain('grant_policy');
    expect(
      (
        await s.call('grant_policy', {
          action: 'a.b',
          resource: 'r',
          scope: 's',
          grantee: { kind: 'runner' },
          idempotencyKey: 'k',
          confirm: true,
        })
      ).status,
    ).toBe(403);
  });

  it('never lets a chief of staff identity exceed that kind, even if linked with more', () => {
    const env = createMcpEnv();
    const human = env.seed('human');
    const cos = env.seed('chief_of_staff');
    expect(() =>
      linkIdentity(env.db, {
        issuer: ISSUER,
        subject: 'bob',
        principalId: cos.principalId,
        scopes: ['policy:write'],
        linkedBy: human.principalId,
      }),
    ).toThrow(/not allowed/);
  });

  it('can link an identity again after it was revoked, and refuses to re-point an active one', () => {
    const env = createMcpEnv();
    const human = env.seed('human');
    const cos = env.seed('chief_of_staff');
    const link = (principalId: string) =>
      linkIdentity(env.db, {
        issuer: ISSUER,
        subject: 'erin',
        principalId,
        linkedBy: human.principalId,
      });
    link(human.principalId);
    expect(() => link(cos.principalId)).toThrow(/already linked/);
    revokeIdentity(env.db, ISSUER, 'erin');
    link(cos.principalId);
    const row = env.db.get<{ principal_id: string; revoked_at: string | null }>(
      'SELECT principal_id, revoked_at FROM oauth_identities WHERE subject = ?',
      ['erin'],
    );
    expect(row).toEqual({ principal_id: cos.principalId, revoked_at: null });
  });

  it('lets only a human link an identity', () => {
    const env = createMcpEnv();
    const cos = env.seed('chief_of_staff');
    const runner = env.seed('runner');
    for (const linker of [cos, runner]) {
      expect(() =>
        linkIdentity(env.db, {
          issuer: ISSUER,
          subject: `s-${linker.principalId}`,
          principalId: cos.principalId,
          linkedBy: linker.principalId,
        }),
      ).toThrow(/human/);
    }
  });

  it('treats a provider that throws as a refusal', async () => {
    const { env, provider } = linked();
    provider.mint('at-1', { subject: 'alice' });
    provider.failWith = new Error('jwks unreachable');
    expect((await env.client('at-1').rpc('ping')).status).toBe(401);
  });

  it('still accepts a Tower token when a provider is configured', async () => {
    const { env } = setup();
    expect((await env.client(env.owner).rpc('ping')).status).toBe(200);
  });

  it('does not accept a provider token on the HTTP API', async () => {
    const { env, provider } = linked();
    provider.mint('at-1', { subject: 'alice' });
    expect((await env.http('at-1', '/missions')).status).toBe(401);
  });
});

describe('public URL', () => {
  it.each([
    ['https://tower.example.test/path'],
    ['https://tower.example.test/?x=1'],
    ['http://tower.example.test'],
    ['ftp://tower.example.test'],
    ['not a url'],
    ['https://user:pw@tower.example.test'],
  ])('refuses %s', (url) => {
    expect(() => resourceUrls(url)).toThrow();
  });

  it('accepts https origins and loopback http, and fails createApp at startup on a bad one', () => {
    expect(resourceUrls('https://tower.example.test').resource).toBe(
      'https://tower.example.test/mcp',
    );
    expect(resourceUrls('http://localhost:8787').resource).toBe(
      'http://localhost:8787/mcp',
    );
    expect(() =>
      createApp({
        db: openTestDatabase(),
        mcp: { publicBaseUrl: 'https://x.test/p' },
      }),
    ).toThrow();
  });

  it('keeps the session and tool surface identical over a provider token', async () => {
    const { env, provider } = setup();
    const human = seedPrincipal(env.db, { kind: 'human' });
    linkIdentity(env.db, {
      issuer: ISSUER,
      subject: 'carol',
      principalId: human.principalId,
      linkedBy: human.principalId,
    });
    provider.mint('at-c', { subject: 'carol', scopes: ['mission:read'] });
    const client = new McpClient(appRequester(env.app), 'at-c');
    expect((await client.initialize()).status).toBe(200);
    expect((await client.call('briefing')).isError).toBe(false);
  });
});
