import { describe, expect, it } from 'vitest';
import { ensureWorkspace } from '../../src/auth/principals.js';
import { seedPrincipal } from '../helpers/tower.js';
import {
  type Api,
  createApi,
  grant,
  missionWith,
  request,
  ruleInput,
} from '../policy/helpers.js';

const RULE = {
  action: 'deploy.staging',
  resource: 'repo:app',
  scope: 'env:staging',
  maxRisk: 'medium',
  grantee: { kind: 'chief_of_staff' },
};

async function createRule(api: Api, body: object = RULE, headers = {}) {
  return api.call(api.owner.token, 'POST', '/policy/rules', body, headers);
}

const READS: Array<[string, string]> = [
  ['GET', '/policy'],
  ['GET', '/policy/rules'],
  ['GET', '/policy/rules/rul_x'],
  ['GET', '/policy/rules/rul_x/history'],
  ['GET', '/policy/history'],
  ['GET', '/policy/receipts'],
  ['GET', '/policy/preferences'],
  ['GET', '/policy/proposals'],
  ['GET', '/policy/proposals/prp_x'],
];

const WRITES: Array<[string, string, object]> = [
  ['POST', '/policy/rules', RULE],
  ['PATCH', '/policy/rules/rul_x', { expectedVersion: 1, note: 'x' }],
  ['POST', '/policy/rules/rul_x/revoke', { expectedVersion: 1 }],
  ['PUT', '/policy/preferences/tone', { value: 'brief' }],
  ['POST', '/policy/proposals/prp_x/accept', {}],
  ['POST', '/policy/proposals/prp_x/narrow', { maxRisk: 'low' }],
  ['POST', '/policy/proposals/prp_x/decline', {}],
];

describe('access to policy routes', () => {
  it('demands a token on every route', async () => {
    const api = createApi();
    for (const [method, path] of READS) {
      expect((await api.call(undefined, method, path)).status, path).toBe(401);
    }
    for (const [method, path, body] of WRITES) {
      expect((await api.call(undefined, method, path, body)).status, path).toBe(
        401,
      );
    }
    expect(
      (await api.call(undefined, 'POST', '/policy/evaluations', {})).status,
    ).toBe(401);
  });

  it.each(['runner', 'provider'] as const)(
    'gives a %s principal nothing, reads included',
    async (who) => {
      const api = createApi();
      const { token } = api[who];
      for (const [method, path] of READS) {
        expect((await api.call(token, method, path)).status, path).toBe(403);
      }
      for (const [method, path, body] of WRITES) {
        expect((await api.call(token, method, path, body)).status, path).toBe(
          403,
        );
      }
      expect(
        (await api.call(token, 'POST', '/policy/evaluations', request()))
          .status,
      ).toBe(403);
      expect(api.h.authority.policy.policyVersion('ws_test')).toBe(0);
    },
  );

  it('lets a Chief of Staff read policy and never change it', async () => {
    const api = createApi();
    const rule = grant(api.h);
    for (const [method, path] of [
      ['GET', '/policy'],
      ['GET', '/policy/rules'],
      ['GET', `/policy/rules/${rule.id}`],
      ['GET', '/policy/history'],
      ['GET', '/policy/receipts'],
    ] as const) {
      expect((await api.call(api.cos.token, method, path)).status, path).toBe(
        200,
      );
    }
    for (const [method, path, body] of WRITES) {
      const response = await api.call(api.cos.token, method, path, body);
      expect(response.status, path).toBe(403);
    }
    const stolen = await api.call(
      api.cos.token,
      'PATCH',
      `/policy/rules/${rule.id}`,
      {
        expectedVersion: 1,
        maxRisk: 'high',
      },
    );
    expect(stolen.status).toBe(403);
    expect(api.h.authority.policy.getRule('ws_test', rule.id)?.maxRisk).toBe(
      'medium',
    );
  });

  it('refuses every write route to a human token that holds only the read scopes', async () => {
    const api = createApi();
    const rule = grant(api.h);
    const reader = seedPrincipal(api.db, {
      kind: 'human',
      scopes: ['policy:read', 'decision:read'],
    });
    for (const [method, path, body] of WRITES) {
      const response = await api.call(
        reader.token,
        method,
        path.replace('rul_x', rule.id),
        body,
      );
      expect(response.status, path).toBe(403);
    }
    expect(api.h.authority.policy.getRule('ws_test', rule.id)?.version).toBe(1);
    expect(api.h.authority.policy.listPreferences('ws_test')).toEqual([]);
  });

  it('refuses a human token without the scope pair that reads', async () => {
    const api = createApi();
    const writerOnly = seedPrincipal(api.db, {
      kind: 'human',
      scopes: ['policy:write'],
    });
    for (const [method, path] of READS) {
      expect(
        (await api.call(writerOnly.token, method, path)).status,
        path,
      ).toBe(403);
    }
  });

  it('refuses a human token whose scopes were narrowed to read-only', async () => {
    const api = createApi();
    const reader = seedPrincipal(api.db, {
      kind: 'human',
      scopes: ['policy:read'],
    });
    expect((await api.call(reader.token, 'GET', '/policy')).status).toBe(200);
    expect(
      (await api.call(reader.token, 'POST', '/policy/rules', RULE)).status,
    ).toBe(403);
  });
});

describe('rules over HTTP', () => {
  it('creates, amends and revokes with versions and attribution', async () => {
    const api = createApi();
    const created = await createRule(api);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      policyVersion: 1,
      replayed: false,
      rule: {
        version: 1,
        effect: 'allow',
        action: 'deploy.staging',
        grantee: { kind: 'chief_of_staff', principalId: null },
        limits: { maxAmount: null, missionIds: null },
        createdBy: api.owner.principalId,
        revokedAt: null,
      },
    });
    const id = created.body.rule.id;

    const amended = await api.call(
      api.owner.token,
      'PATCH',
      `/policy/rules/${id}`,
      {
        expectedVersion: 1,
        maxRisk: 'high',
        limits: { maxAmount: 50 },
        expiresAt: '2026-04-01T00:00:00Z',
      },
    );
    expect(amended.status).toBe(200);
    expect(amended.body).toMatchObject({
      policyVersion: 2,
      rule: {
        version: 2,
        maxRisk: 'high',
        limits: { maxAmount: 50, missionIds: null },
        expiresAt: '2026-04-01T00:00:00.000Z',
      },
    });

    const stale = await api.call(
      api.owner.token,
      'PATCH',
      `/policy/rules/${id}`,
      {
        expectedVersion: 1,
        note: 'late',
      },
    );
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('version_conflict');

    const revoked = await api.call(
      api.owner.token,
      'POST',
      `/policy/rules/${id}/revoke`,
      {
        expectedVersion: 2,
        reason: 'retired',
      },
    );
    expect(revoked.body).toMatchObject({
      policyVersion: 3,
      rule: {
        version: 3,
        revokedBy: api.owner.principalId,
        revokeReason: 'retired',
      },
    });
    expect(
      (
        await api.call(api.owner.token, 'PATCH', `/policy/rules/${id}`, {
          expectedVersion: 3,
          note: 'x',
        })
      ).status,
    ).toBe(409);

    const read = await api.call(api.owner.token, 'GET', `/policy/rules/${id}`);
    expect(read.body.rule.version).toBe(3);
    const active = await api.call(
      api.owner.token,
      'GET',
      '/policy/rules?status=active',
    );
    expect(active.body).toMatchObject({ policyVersion: 3, rules: [] });
    const inactive = await api.call(
      api.owner.token,
      'GET',
      '/policy/rules?status=inactive',
    );
    expect(inactive.body.rules).toHaveLength(1);
  });

  it.each([
    ['2030-01-01T10:00Z', '2030-01-01T10:00:00.000Z'],
    ['2030-01-01T10:00+10:00', '2030-01-01T00:00:00.000Z'],
    ['2030-01-01T10:00-05:00', '2030-01-01T15:00:00.000Z'],
    ['2030-01-01T10:00:30.5Z', '2030-01-01T10:00:30.500Z'],
    ['2032-02-29T00:00:00Z', '2032-02-29T00:00:00.000Z'],
    ['2400-02-29T00:00:00Z', '2400-02-29T00:00:00.000Z'],
  ])('accepts %s', async (expiresAt, canonical) => {
    const api = createApi();
    const created = await createRule(api, { ...RULE, expiresAt });
    expect(created.status).toBe(201);
    expect(created.body.rule.expiresAt).toBe(canonical);
  });

  it.each([
    '2100-02-29T00:00:00Z',
    '1900-02-29T00:00:00Z',
    '2030-13-01T00:00:00Z',
    '2030-00-10T00:00:00Z',
    '2030-01-00T00:00:00Z',
    '2030-01-01T10:60:00Z',
    '2030-01-01T10:00:60Z',
  ])('rejects %s', async (expiresAt) => {
    const api = createApi();
    expect((await createRule(api, { ...RULE, expiresAt })).status).toBe(400);
  });

  it('accepts a leap day', async () => {
    const api = createApi();
    const created = await createRule(api, {
      ...RULE,
      expiresAt: '2028-02-29T23:59:59Z',
    });
    expect(created.body.rule.expiresAt).toBe('2028-02-29T23:59:59.000Z');
  });

  it('reads an expiry with an offset as the instant it names', async () => {
    const api = createApi();
    const created = await createRule(api, {
      ...RULE,
      expiresAt: '2030-01-01T10:00:00+08:00',
    });
    expect(created.body.rule.expiresAt).toBe('2030-01-01T02:00:00.000Z');
  });

  it('repeats a creation safely with an idempotency key', async () => {
    const api = createApi();
    const first = await createRule(api, RULE, { 'idempotency-key': 'k1' });
    const again = await createRule(api, RULE, { 'idempotency-key': 'k1' });
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({
      replayed: true,
      rule: { id: first.body.rule.id },
    });
    const other = await createRule(
      api,
      { ...RULE, resource: 'repo:other' },
      { 'idempotency-key': 'k1' },
    );
    expect(other.status).toBe(400);
    expect(
      (await api.call(api.owner.token, 'GET', '/policy/rules')).body.rules,
    ).toHaveLength(1);
  });

  it.each([
    ['an unknown field', { ...RULE, extra: 1 }],
    ['a missing grantee', { ...RULE, grantee: undefined }],
    ['an empty grantee', { ...RULE, grantee: {} }],
    ['an unknown kind', { ...RULE, grantee: { kind: 'wizard' } }],
    ['an upper-case action', { ...RULE, action: 'Deploy.Staging' }],
    ['a pattern with control characters', { ...RULE, resource: 'repo:\u0007' }],
    ['too many wildcards', { ...RULE, resource: '*a*b*c*d*e*f*g*h*i*' }],
    ['a past expiry', { ...RULE, expiresAt: '2020-01-01T00:00:00Z' }],
    ['a bad expiry', { ...RULE, expiresAt: 'tomorrow' }],
    [
      'an expiry with no time zone',
      { ...RULE, expiresAt: '2030-01-01T00:00:00' },
    ],
    ['an expiry with only a date', { ...RULE, expiresAt: '2030-01-01' }],
    [
      'a date that does not exist',
      { ...RULE, expiresAt: '2030-02-30T00:00:00Z' },
    ],
    ['an hour of 24', { ...RULE, expiresAt: '2030-12-31T24:00:00Z' }],
    ['a thirty-first of April', { ...RULE, expiresAt: '2030-04-31T00:00:00Z' }],
    ['a free-form expiry', { ...RULE, expiresAt: 'Jan 1 2030 10:00' }],
    ['a negative cap', { ...RULE, limits: { maxAmount: -1 } }],
    ['a fractional cap', { ...RULE, limits: { maxAmount: 1.5 } }],
    ['an empty mission list', { ...RULE, limits: { missionIds: [] } }],
    [
      'a deny rule with a cap',
      { ...RULE, effect: 'deny', limits: { maxAmount: 1 } },
    ],
    [
      'a grantee outside the workspace',
      { ...RULE, grantee: { principalId: 'prn_nobody' } },
    ],
  ])('rejects %s with a 400 and writes nothing', async (_name, body) => {
    const api = createApi();
    const response = await createRule(api, body);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('validation_failed');
    expect(api.h.authority.policy.policyVersion('ws_test')).toBe(0);
  });

  it('answers 404 for a rule that does not exist or belongs to another workspace', async () => {
    const api = createApi();
    const created = await createRule(api);
    expect(
      (await api.call(api.owner.token, 'GET', '/policy/rules/rul_nope')).status,
    ).toBe(404);
    ensureWorkspace(api.db, 'ws_elsewhere', 'elsewhere');
    const foreign = seedPrincipal(api.db, {
      kind: 'human',
      workspaceId: 'ws_elsewhere',
    });
    for (const [method, path, body] of [
      ['GET', `/policy/rules/${created.body.rule.id}`, undefined],
      [
        'PATCH',
        `/policy/rules/${created.body.rule.id}`,
        { expectedVersion: 1, note: 'x' },
      ],
      [
        'POST',
        `/policy/rules/${created.body.rule.id}/revoke`,
        { expectedVersion: 1 },
      ],
    ] as const) {
      expect(
        (await api.call(foreign.token, method, path, body)).status,
        path,
      ).toBe(404);
    }
    const list = await api.call(foreign.token, 'GET', '/policy/rules');
    expect(list.body.rules).toEqual([]);
    expect(
      (await api.call(foreign.token, 'GET', '/policy/history')).body.items,
    ).toEqual([]);
  });

  it('rejects an oversized or malformed body', async () => {
    const api = createApi();
    const big = await api.call(api.owner.token, 'POST', '/policy/rules', {
      ...RULE,
      note: 'x'.repeat(300_000),
    });
    expect(big.status).toBe(413);
    const res = await api.call(
      api.owner.token,
      'POST',
      '/policy/rules',
      'not json' as unknown as object,
    );
    expect([400, 413]).toContain(res.status);
  });
});

describe('auditing authority changes', () => {
  it('shows every change with who made it, in order, and pages', async () => {
    const api = createApi();
    const a = await createRule(api);
    const b = await createRule(api, { ...RULE, action: 'docs.publish' });
    await api.call(
      api.owner.token,
      'PATCH',
      `/policy/rules/${a.body.rule.id}`,
      { expectedVersion: 1, note: 'n' },
    );
    await api.call(
      api.owner.token,
      'POST',
      `/policy/rules/${b.body.rule.id}/revoke`,
      { expectedVersion: 1 },
    );

    const all = await api.call(api.cos.token, 'GET', '/policy/history');
    expect(all.status).toBe(200);
    expect(all.body.items.map((i: { type: string }) => i.type)).toEqual([
      'policy.rule.created',
      'policy.rule.created',
      'policy.rule.amended',
      'policy.rule.revoked',
    ]);
    expect(
      all.body.items.every(
        (i: { actorId: string }) => i.actorId === api.owner.principalId,
      ),
    ).toBe(true);
    expect(all.body.items[2].payload).toMatchObject({
      changed: ['note'],
      policyVersion: 3,
    });

    const page = await api.call(
      api.owner.token,
      'GET',
      '/policy/history?limit=3',
    );
    expect(page.body.items).toHaveLength(3);
    expect(page.body.nextAfterVersion).toBe(3);
    const next = await api.call(
      api.owner.token,
      'GET',
      '/policy/history?after=3&limit=3',
    );
    expect(next.body.items.map((i: { version: number }) => i.version)).toEqual([
      4,
    ]);
    expect(next.body.nextAfterVersion).toBeNull();

    const one = await api.call(
      api.owner.token,
      'GET',
      `/policy/rules/${a.body.rule.id}/history`,
    );
    expect(one.body.items.map((i: { type: string }) => i.type)).toEqual([
      'policy.rule.created',
      'policy.rule.amended',
    ]);
    expect(
      (await api.call(api.owner.token, 'GET', '/policy/history?limit=0'))
        .status,
    ).toBe(400);
  });

  it('lists denied guarded effects as receipts', async () => {
    const api = createApi();
    const created = await createRule(api, {
      ...RULE,
      action: 'land.merge',
      scope: 'branch:main',
    });
    await api.call(
      api.owner.token,
      'POST',
      `/policy/rules/${created.body.rule.id}/revoke`,
      { expectedVersion: 1 },
    );
    expect(() =>
      api.h.authority.policy.guard(
        request({ action: 'land.merge', scope: 'branch:main' }),
      ),
    ).toThrow();
    const receipts = await api.call(api.cos.token, 'GET', '/policy/receipts');
    expect(receipts.body.receipts).toMatchObject([
      {
        action: 'land.merge',
        effect: 'deny',
        code: 'grant_revoked',
        ruleId: created.body.rule.id,
        policyVersion: 2,
      },
    ]);
  });
});

describe('receipts and the rule list', () => {
  it('pages receipts and lists revoked rules by default', async () => {
    const api = createApi();
    const created = await createRule(api, { ...RULE, action: 'land.merge' });
    await api.call(
      api.owner.token,
      'POST',
      `/policy/rules/${created.body.rule.id}/revoke`,
      { expectedVersion: 1 },
    );
    for (let n = 0; n < 3; n++) {
      expect(() =>
        api.h.authority.policy.guard(request({ action: 'land.merge' })),
      ).toThrow();
    }
    const first = await api.call(
      api.owner.token,
      'GET',
      '/policy/receipts?limit=2',
    );
    expect(first.body.receipts).toHaveLength(2);
    expect(first.body.nextAfter).toBe(first.body.receipts[1].seq);
    const second = await api.call(
      api.owner.token,
      'GET',
      `/policy/receipts?limit=2&after=${first.body.nextAfter}`,
    );
    expect(second.body.receipts).toHaveLength(1);
    expect(second.body.nextAfter).toBeNull();
    const rules = await api.call(api.owner.token, 'GET', '/policy/rules');
    expect(rules.body.rules).toHaveLength(1);
    expect(rules.body.rules[0].revokedAt).not.toBeNull();
  });

  it('keeps receipts, proposals and preferences inside the caller workspace', async () => {
    const api = createApi();
    await api.call(api.owner.token, 'PUT', '/policy/preferences/tone', {
      value: 'brief',
    });
    expect(() => api.h.authority.policy.guard(request())).toThrow();
    ensureWorkspace(api.db, 'ws_elsewhere', 'elsewhere');
    const foreign = seedPrincipal(api.db, {
      kind: 'human',
      workspaceId: 'ws_elsewhere',
    });
    for (const [path, key] of [
      ['/policy/receipts', 'receipts'],
      ['/policy/preferences', 'preferences'],
      ['/policy/proposals', 'proposals'],
    ] as const) {
      expect(
        (await api.call(foreign.token, 'GET', path)).body[key],
        path,
      ).toEqual([]);
    }
  });
});

describe('evaluating over HTTP', () => {
  const ASK = {
    action: 'deploy.staging',
    resource: 'repo:app',
    scope: 'env:staging',
    risk: 'low',
  };

  it('answers for the caller, or for a named principal, and records nothing', async () => {
    const api = createApi();
    await createRule(api);
    const own = await api.call(
      api.cos.token,
      'POST',
      '/policy/evaluations',
      ASK,
    );
    expect(own.body.evaluation).toMatchObject({
      effect: 'allow',
      code: 'granted',
      policyVersion: 1,
    });
    const owner = await api.call(
      api.owner.token,
      'POST',
      '/policy/evaluations',
      ASK,
    );
    expect(owner.body.evaluation).toMatchObject({
      effect: 'deny',
      code: 'no_matching_grant',
    });
    const named = await api.call(
      api.owner.token,
      'POST',
      '/policy/evaluations',
      { ...ASK, principalId: api.cos.principalId },
    );
    expect(named.body.evaluation.effect).toBe('allow');
    const high = await api.call(api.cos.token, 'POST', '/policy/evaluations', {
      ...ASK,
      risk: 'high',
    });
    expect(high.body.evaluation.effect).toBe('deny');
    expect(
      api.h.authority.policy.receipts('ws_test', { afterSeq: 0, limit: 10 }),
    ).toEqual([]);
  });

  it('allows grantless cleanup for the runner holding the attempt lease, as a dry run', async () => {
    const api = createApi();
    const { driver, ids } = missionWith(api.h, [
      { title: 'one', scope: ['tmp/*'], authorized: true },
    ]);
    api.h.pool.online = [api.h.runner.id];
    driver.tick();
    const attemptId = driver.refresh().packets[0]?.activeAttemptId as string;
    expect(ids).toHaveLength(1);
    const cleanup = {
      action: 'cleanup.release-lease',
      resource: 'files:tmp',
      scope: 'runner:a',
      risk: 'low',
      principalId: api.h.runner.id,
      missionId: driver.id,
    };
    const ask = async (extra: object) =>
      (
        await api.call(api.owner.token, 'POST', '/policy/evaluations', {
          ...cleanup,
          ...extra,
        })
      ).body.evaluation;
    expect(await ask({ attemptId })).toMatchObject({ code: 'safe_cleanup' });
    expect(await ask({})).toMatchObject({ code: 'no_matching_grant' });
    expect(await ask({ attemptId, resource: 'db:orders' })).toMatchObject({
      code: 'no_matching_grant',
    });
  });

  it('rejects a malformed request', async () => {
    const api = createApi();
    for (const body of [
      {},
      { ...ASK, risk: 'severe' },
      { ...ASK, action: 'Not Valid' },
      { ...ASK, amount: 'a lot' },
    ]) {
      expect(
        (await api.call(api.owner.token, 'POST', '/policy/evaluations', body))
          .status,
      ).toBe(400);
    }
  });
});

describe('preferences over HTTP', () => {
  it('are kept apart from rules and change no evaluation', async () => {
    const api = createApi();
    const ASK = {
      action: 'deploy.staging',
      resource: 'repo:app',
      scope: 'env:staging',
      risk: 'low',
    };
    const before = await api.call(
      api.cos.token,
      'POST',
      '/policy/evaluations',
      ASK,
    );
    const put = await api.call(
      api.owner.token,
      'PUT',
      '/policy/preferences/auto-approve:deploy.staging',
      { value: true },
    );
    expect(put.body.preference).toMatchObject({
      key: 'auto-approve:deploy.staging',
      value: true,
      version: 1,
      updatedBy: api.owner.principalId,
    });
    await api.call(api.owner.token, 'PUT', '/policy/preferences/tone', {
      value: { style: 'plain' },
    });
    const listed = await api.call(api.cos.token, 'GET', '/policy/preferences');
    expect(listed.body.preferences.map((p: { key: string }) => p.key)).toEqual([
      'auto-approve:deploy.staging',
      'tone',
    ]);
    const after = await api.call(
      api.cos.token,
      'POST',
      '/policy/evaluations',
      ASK,
    );
    expect(after.body).toEqual(before.body);
    const policy = await api.call(api.cos.token, 'GET', '/policy');
    expect(policy.body).toMatchObject({
      policyVersion: 0,
      rules: [],
      proposals: [],
    });
    expect(policy.body.preferences).toHaveLength(2);
  });

  it('rejects a bad key, an extra field and a huge value', async () => {
    const api = createApi();
    for (const [key, body] of [
      ['bad key!', { value: 1 }],
      ['ok', { value: 1, extra: 2 }],
      ['ok', {}],
      ['ok', { value: 'x'.repeat(5000) }],
    ] as const) {
      expect(
        (
          await api.call(
            api.owner.token,
            'PUT',
            `/policy/preferences/${encodeURIComponent(key)}`,
            body,
          )
        ).status,
      ).toBe(400);
    }
  });
});

describe('proposals over HTTP', () => {
  function propose(api: Api) {
    let proposal: unknown;
    for (const n of [1, 2, 3]) {
      proposal = api.h.authority.policy.observeApproval('ws_test', {
        decisionId: `dec_${n}`,
        action: 'deploy.staging',
        resource: 'repo:app',
        scope: 'env:staging',
        risk: 'medium',
        amount: null,
        approvedBy: api.h.owner.id,
        at: '2026-03-01T00:00:00.000Z',
      });
    }
    return (proposal as { id: string }).id;
  }
  const ASK = {
    action: 'deploy.staging',
    resource: 'repo:app',
    scope: 'env:staging',
    risk: 'medium',
  };

  it('stay pending, and grant nothing, until a human accepts', async () => {
    const api = createApi();
    const id = propose(api);
    const list = await api.call(
      api.cos.token,
      'GET',
      '/policy/proposals?status=pending',
    );
    expect(list.body.proposals).toMatchObject([
      { id, status: 'pending', approvals: 3 },
    ]);
    expect(
      (await api.call(api.cos.token, 'POST', '/policy/evaluations', ASK)).body
        .evaluation.effect,
    ).toBe('deny');
    expect(
      (
        await api.call(
          api.cos.token,
          'POST',
          `/policy/proposals/${id}/accept`,
          {},
        )
      ).status,
    ).toBe(403);
    expect(
      (await api.call(api.cos.token, 'POST', '/policy/evaluations', ASK)).body
        .evaluation.effect,
    ).toBe('deny');

    const accepted = await api.call(
      api.owner.token,
      'POST',
      `/policy/proposals/${id}/accept`,
      { note: 'ok' },
    );
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({
      proposal: { status: 'accepted', resolvedBy: api.owner.principalId },
      rule: { sourceProposalId: id, maxRisk: 'medium' },
    });
    expect(
      (await api.call(api.cos.token, 'POST', '/policy/evaluations', ASK)).body
        .evaluation.effect,
    ).toBe('allow');

    const detail = await api.call(
      api.owner.token,
      'GET',
      `/policy/proposals/${id}`,
    );
    expect(detail.body.history.map((i: { type: string }) => i.type)).toEqual([
      'policy.proposal.created',
      'policy.rule.created',
      'policy.proposal.resolved',
    ]);
    expect(
      (
        await api.call(
          api.owner.token,
          'POST',
          `/policy/proposals/${id}/accept`,
          {},
        )
      ).status,
    ).toBe(409);
  });

  it('can be narrowed, but never widened', async () => {
    const api = createApi();
    const id = propose(api);
    const wide = await api.call(
      api.owner.token,
      'POST',
      `/policy/proposals/${id}/narrow`,
      { maxRisk: 'high' },
    );
    expect(wide.status).toBe(422);
    expect(wide.body.error.code).toBe('widening_rejected');
    const wideResource = await api.call(
      api.owner.token,
      'POST',
      `/policy/proposals/${id}/narrow`,
      { resource: '*' },
    );
    expect(wideResource.status).toBe(422);
    expect(
      (
        await api.call(
          api.owner.token,
          'POST',
          `/policy/proposals/${id}/narrow`,
          {},
        )
      ).status,
    ).toBe(400);
    expect(api.h.authority.policy.listRules('ws_test')).toEqual([]);

    const narrowed = await api.call(
      api.owner.token,
      'POST',
      `/policy/proposals/${id}/narrow`,
      {
        maxRisk: 'low',
        granteePrincipalId: api.cos.principalId,
        note: 'low only',
      },
    );
    expect(narrowed.body).toMatchObject({
      proposal: { status: 'narrowed' },
      rule: {
        maxRisk: 'low',
        grantee: { kind: 'chief_of_staff', principalId: api.cos.principalId },
      },
    });
    expect(
      (
        await api.call(api.cos.token, 'POST', '/policy/evaluations', {
          ...ASK,
          risk: 'medium',
        })
      ).body.evaluation.effect,
    ).toBe('deny');
    expect(
      (
        await api.call(api.cos.token, 'POST', '/policy/evaluations', {
          ...ASK,
          risk: 'low',
        })
      ).body.evaluation.effect,
    ).toBe('allow');
  });

  it('can be declined, which grants nothing and is final', async () => {
    const api = createApi();
    const id = propose(api);
    const declined = await api.call(
      api.owner.token,
      'POST',
      `/policy/proposals/${id}/decline`,
      { note: 'no' },
    );
    expect(declined.body.proposal).toMatchObject({
      status: 'declined',
      resolutionNote: 'no',
      resultingRuleId: null,
    });
    expect(
      (
        await api.call(
          api.owner.token,
          'POST',
          `/policy/proposals/${id}/accept`,
          {},
        )
      ).status,
    ).toBe(409);
    expect(
      (await api.call(api.cos.token, 'POST', '/policy/evaluations', ASK)).body
        .evaluation.effect,
    ).toBe('deny');
    expect(
      (await api.call(api.owner.token, 'GET', '/policy/proposals/prp_nope'))
        .status,
    ).toBe(404);
    expect(
      (await api.call(api.owner.token, 'GET', '/policy/proposals?status=maybe'))
        .status,
    ).toBe(400);
  });
});

describe('a rule never reaches another workspace', () => {
  it('evaluates only against its own workspace', async () => {
    const api = createApi();
    ensureWorkspace(api.db, 'ws_elsewhere', 'elsewhere');
    const foreignCos = seedPrincipal(api.db, {
      kind: 'chief_of_staff',
      workspaceId: 'ws_elsewhere',
    });
    await createRule(api, { ...RULE, grantee: { kind: 'chief_of_staff' } });
    const response = await api.call(
      foreignCos.token,
      'POST',
      '/policy/evaluations',
      {
        action: 'deploy.staging',
        resource: 'repo:app',
        scope: 'env:staging',
        risk: 'low',
      },
    );
    expect(response.body.evaluation).toMatchObject({
      effect: 'deny',
      policyVersion: 0,
    });
    expect(ruleInput().action).toBe('deploy.staging');
  });
});
