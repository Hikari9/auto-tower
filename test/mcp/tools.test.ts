import { describe, expect, it } from 'vitest';
import { key } from './helpers.js';
import { createMcpEnv, MISSION } from './setup.js';

describe('mutating tools', () => {
  it('require an idempotency key and write nothing without one', async () => {
    const env = createMcpEnv();
    const s = await env.session(env.owner);
    const noKey = await s.call('create_mission', MISSION);
    expect(noKey.isError).toBe(true);
    expect(noKey.data.error.code).toBe('idempotency_key_required');
    const badKey = await s.call('create_mission', {
      ...MISSION,
      idempotencyKey: 'has space',
    });
    expect(badKey.data.error.code).toBe('idempotency_key_required');
    expect((await s.ok('search_missions')).total).toBe(0);
  });

  it('replay the first result for the same key and arguments, and act once', async () => {
    const env = createMcpEnv();
    const s = await env.session(env.owner);
    const k = key('create');
    const first = await s.call('create_mission', {
      ...MISSION,
      idempotencyKey: k,
    });
    const second = await s.call('create_mission', {
      ...MISSION,
      idempotencyKey: k,
    });
    expect(first.isError).toBe(false);
    expect(second.data.mission.id).toBe(first.data.mission.id);
    expect(second.meta?.['tower/replayed']).toBe(true);
    expect(first.meta).toBeUndefined();
    expect((await s.ok('search_missions')).total).toBe(1);
  });

  it('replay across sessions of the same principal', async () => {
    const env = createMcpEnv();
    const a = await env.session(env.owner);
    const b = await env.session(env.owner);
    const k = key('x');
    const first = await a.ok('create_mission', {
      ...MISSION,
      idempotencyKey: k,
    });
    const again = await b.ok('create_mission', {
      ...MISSION,
      idempotencyKey: k,
    });
    expect(again.mission.id).toBe(first.mission.id);
  });

  it('refuse the same key with other arguments or another tool', async () => {
    const env = createMcpEnv();
    const s = await env.session(env.owner);
    const k = key('reuse');
    await s.ok('create_mission', { ...MISSION, idempotencyKey: k });
    const changed = await s.call('create_mission', {
      ...MISSION,
      title: 'Other',
      idempotencyKey: k,
    });
    expect(changed.data.error.code).toBe('idempotency_key_reused');
    const other = await s.call('propose_policy_change', { idempotencyKey: k });
    expect(other.data.error.code).toBe('idempotency_key_reused');
    expect((await s.ok('search_missions')).total).toBe(1);
  });

  it('pass the key to the core as its idempotency and correlation key, so the event log dedupes without the stored result', async () => {
    const env = createMcpEnv();
    const s = await env.session(env.owner);
    const k = key('core');
    const first = await s.ok('create_mission', {
      ...MISSION,
      idempotencyKey: k,
    });
    const event = env.db.get<{ correlation_id: string }>(
      'SELECT correlation_id FROM events WHERE stream_id = ?',
      [`mission:${first.mission.id}`],
    );
    expect(event?.correlation_id).toBe(k);
    expect(
      env.db.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM idempotency_keys WHERE idempotency_key = ?',
        [k],
      )?.n,
    ).toBe(1);

    // Lose the stored MCP result, as a crash between the effect and the store would.
    env.db.run('DELETE FROM mcp_idempotency');
    const again = await s.ok('create_mission', {
      ...MISSION,
      idempotencyKey: k,
    });
    expect(again.mission.id).toBe(first.mission.id);
    expect(again.replayed).toBe(true);
    expect((await s.ok('search_missions')).total).toBe(1);
  });

  it('report success when the result cannot be stored, and dedupe the retry through the core', async () => {
    const env = createMcpEnv();
    const s = await env.session(env.owner);
    env.db.exec(
      "CREATE TRIGGER no_store BEFORE INSERT ON mcp_idempotency BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    const k = key('nostore');
    const first = await s.call('create_mission', {
      ...MISSION,
      idempotencyKey: k,
    });
    expect(first.isError).toBe(false);
    const retry = await s.ok('create_mission', {
      ...MISSION,
      idempotencyKey: k,
    });
    expect(retry.mission.id).toBe(first.data.mission.id);
    expect((await s.ok('search_missions')).total).toBe(1);
  });

  it('treat null arguments as none', async () => {
    const env = createMcpEnv();
    const s = await env.session(env.owner);
    const reply = await s.rpc('tools/call', {
      name: 'briefing',
      arguments: null,
    });
    expect(reply.body.result.isError).toBe(false);
    const bad = await s.rpc('tools/call', { name: 'briefing', arguments: 'x' });
    expect(bad.body.error.code).toBe(-32602);
  });

  it('scope a key to the caller, so another principal cannot replay it', async () => {
    const env = createMcpEnv();
    const a = await env.session(env.owner);
    const b = await env.session(env.cos);
    const k = key('shared');
    const mine = await a.ok('create_mission', {
      ...MISSION,
      idempotencyKey: k,
    });
    const theirs = await b.ok('create_mission', {
      ...MISSION,
      idempotencyKey: k,
    });
    expect(theirs.mission.id).not.toBe(mine.mission.id);
  });

  it('do not store a failed call, so its key can be used again', async () => {
    const env = createMcpEnv();
    const s = await env.session(env.owner);
    const k = key('retry');
    const bad = await s.call('create_mission', {
      title: 'x',
      idempotencyKey: k,
    });
    expect(bad.data.error.code).toBe('validation_failed');
    const good = await s.call('create_mission', {
      ...MISSION,
      idempotencyKey: k,
    });
    expect(good.isError).toBe(false);
  });

  it('refuse an unknown argument rather than ignore it', async () => {
    const env = createMcpEnv();
    const s = await env.session(env.owner);
    const reply = await s.call('create_mission', {
      ...MISSION,
      idempotencyKey: key(),
      extra: 1,
    });
    expect(reply.data.error.code).toBe('validation_failed');
  });

  it('reject a confirm argument on a tool that is not material', async () => {
    const env = createMcpEnv();
    const s = await env.session(env.owner);
    const reply = await s.call('create_mission', {
      ...MISSION,
      idempotencyKey: key(),
      confirm: true,
    });
    expect(reply.data.error.code).toBe('validation_failed');
  });

  it('reject an idempotency key on a read-only tool', async () => {
    const env = createMcpEnv();
    const s = await env.session(env.owner);
    const reply = await s.call('briefing', { idempotencyKey: key() });
    expect(reply.data.error.code).toBe('validation_failed');
  });
});

describe('material tools', () => {
  it.each([
    [
      'close_mission',
      { missionId: 'x', expectedVersion: 1, outcome: 'cancelled' },
    ],
    ['request_dispatch', { missionId: 'x', packetId: 'p', expectedVersion: 1 }],
    [
      'grant_policy',
      {
        action: 'a.b',
        resource: 'r',
        scope: 's',
        grantee: { kind: 'chief_of_staff' },
      },
    ],
    ['revoke_policy', { ruleId: 'x', expectedVersion: 1 }],
  ])('%s refuses to run without confirm: true', async (name, args) => {
    const env = createMcpEnv();
    const s = await env.session(env.owner);
    for (const confirm of [undefined, false, 'true', 1]) {
      const reply = await s.call(name, {
        ...args,
        idempotencyKey: key(),
        ...(confirm === undefined ? {} : { confirm }),
      });
      expect(reply.isError, String(confirm)).toBe(true);
      expect(reply.data.error.code, String(confirm)).toBe(
        'confirmation_required',
      );
    }
  });

  it('does not store a result for an unconfirmed call, so confirming with the same key works', async () => {
    const env = createMcpEnv();
    const s = await env.session(env.owner);
    const created = await s.ok('create_mission', {
      ...MISSION,
      idempotencyKey: key(),
    });
    const args = {
      missionId: created.mission.id,
      expectedVersion: created.mission.version,
      outcome: 'cancelled',
    };
    const k = key('close');
    expect(
      (await s.call('close_mission', { ...args, idempotencyKey: k })).data.error
        .code,
    ).toBe('confirmation_required');
    const confirmed = await s.ok('close_mission', {
      ...args,
      idempotencyKey: k,
      confirm: true,
    });
    expect(confirmed.mission.state).toBe('cancelled');
  });
});

describe('scopes', () => {
  it('answers 403 with an insufficient_scope challenge and runs nothing', async () => {
    const env = createMcpEnv();
    const readOnly = env.seed('human', ['mission:read']);
    const s = await env.session(readOnly.token);
    const reply = await s.call('create_mission', {
      ...MISSION,
      idempotencyKey: key(),
    });
    expect(reply.status).toBe(403);
    expect(reply.reply.body.error.data.requiredScopes).toEqual([
      'mission:write',
    ]);
    expect(reply.reply.headers.get('www-authenticate')).toBe(
      'Bearer error="insufficient_scope", scope="mission:write"',
    );
    expect((await s.ok('search_missions')).total).toBe(0);
  });

  it('checks every scope a tool needs, not just one', async () => {
    const env = createMcpEnv();
    // Same shape as a chief of staff: no policy:write, so no grant, and no runner:read.
    const s = await env.session(env.cos);
    for (const [name, args] of [
      [
        'grant_policy',
        {
          action: 'a.b',
          resource: 'r',
          scope: 's',
          grantee: { kind: 'runner' },
          confirm: true,
        },
      ],
      ['revoke_policy', { ruleId: 'x', expectedVersion: 1, confirm: true }],
      [
        'set_feature_flag',
        { flag: 'hosted_execution', enabled: false, confirm: true },
      ],
    ] as const) {
      const reply = await s.call(name, { ...args, idempotencyKey: key() });
      expect(reply.status, name).toBe(403);
    }
    expect((await s.call('list_runners')).status).toBe(403);
  });

  it('refuses a runner principal every mutating mission tool', async () => {
    const env = createMcpEnv();
    const s = await env.session(env.runner);
    for (const [name, args] of [
      ['create_mission', MISSION],
      ['update_mission', { missionId: 'x', expectedVersion: 1, title: 't' }],
      [
        'close_mission',
        {
          missionId: 'x',
          expectedVersion: 1,
          outcome: 'cancelled',
          confirm: true,
        },
      ],
      [
        'request_dispatch',
        { missionId: 'x', packetId: 'p', expectedVersion: 1, confirm: true },
      ],
      ['answer_decision', { decisionId: 'd', version: 1, choice: 'approve' }],
    ] as const) {
      const reply = await s.call(name, { ...args, idempotencyKey: key() });
      expect(reply.status, name).toBe(403);
    }
    // It may read. The runner list shows it only itself, which is nothing until it enrolls.
    expect((await s.call('briefing')).status).toBe(200);
    expect((await s.ok('list_runners')).runners).toEqual([]);
  });

  it('records every call in an audit that holds no arguments or results', async () => {
    const env = createMcpEnv();
    const s = await env.session(env.owner);
    await s.ok('create_mission', {
      ...MISSION,
      title: 'SECRET-TITLE',
      idempotencyKey: key(),
    });
    await s.call('create_mission', { ...MISSION });
    const rows = env.db.all<Record<string, unknown>>(
      'SELECT * FROM mcp_audit ORDER BY seq',
    );
    expect(rows.map((r) => [r.tool, r.outcome, r.error_code])).toEqual([
      ['create_mission', 'ok', null],
      ['create_mission', 'refused', 'idempotency_key_required'],
    ]);
    expect(JSON.stringify(rows)).not.toContain('SECRET-TITLE');
    expect(() => env.db.run("UPDATE mcp_audit SET outcome = 'ok'")).toThrow(
      /append-only/,
    );
    expect(() => env.db.run('DELETE FROM mcp_audit')).toThrow(/append-only/);
  });
});
