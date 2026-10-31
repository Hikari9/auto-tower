import { describe, expect, it } from 'vitest';
import { ensureWorkspace } from '../../src/auth/principals.js';
import { seedPrincipal } from '../helpers/tower.js';
import {
  type Api,
  createApi,
  grant,
  missionWith,
  packetStatus,
} from '../policy/helpers.js';

function blocked(api: Api, packets = 1) {
  return missionWith(
    api.h,
    Array.from({ length: packets }, (_, i) => ({ title: `wait ${i}` })),
  );
}

function body(
  missionId: string,
  packetId: string | null,
  overrides: object = {},
) {
  return {
    dedupeKey: 'dk-1',
    category: 'scope_expansion',
    urgency: 'normal',
    question: 'May the follow-up touch billing?',
    recommendation: { alternativeId: 'approve', rationale: 'Low risk.' },
    consequences: 'Billing files may change.',
    evidence: ['ev:plan'],
    affectedScope: ['src/billing'],
    advisory: { confidencePercent: 80 },
    branches: [{ missionId, packetId }],
    ...overrides,
  };
}

const REQUEST = {
  action: 'scope.extend',
  resource: 'repo:app',
  scope: 'infra',
  risk: 'low',
};

const READS: Array<[string, string]> = [
  ['GET', '/decisions'],
  ['GET', '/decisions/dec_x'],
  ['GET', '/decisions/dec_x/history'],
];
const WRITES: Array<[string, string, object]> = [
  ['POST', '/decisions', body('msn_x', null)],
  ['POST', '/decisions/dec_x/answers', { version: 1, choice: 'approve' }],
  [
    'POST',
    '/expansions',
    {
      missionId: 'msn_x',
      action: 'scope.extend',
      resource: 'repo:app',
      scope: 'infra',
      risk: 'low',
      question: 'May I?',
    },
  ],
];

describe('access to decision routes', () => {
  it('demands a token on every route', async () => {
    const api = createApi();
    for (const [method, path] of READS) {
      expect((await api.call(undefined, method, path)).status, path).toBe(401);
    }
    for (const [method, path, payload] of WRITES) {
      expect(
        (await api.call(undefined, method, path, payload)).status,
        path,
      ).toBe(401);
    }
  });

  it.each(['runner', 'provider'] as const)(
    'gives a %s principal no way to create, read or answer',
    async (who) => {
      const api = createApi();
      const m = blocked(api);
      const created = api.h.authority.decisions.create(
        { workspaceId: 'ws_test', actor: api.h.owner },
        {
          dedupeKey: 'dk-1',
          category: 'scope_expansion',
          urgency: 'normal',
          question: 'q',
          alternatives: [
            {
              id: 'approve',
              label: 'Approve',
              description: null,
              consequence: null,
              resumes: true,
            },
            {
              id: 'decline',
              label: 'Decline',
              description: null,
              consequence: null,
              resumes: false,
            },
          ],
          recommendation: null,
          consequences: '',
          requiredAuthority: 'human',
          evidence: [],
          affectedScope: [],
          request: null,
          advisory: { confidencePercent: null },
          branches: [{ missionId: m.driver.id, packetId: m.ids[0] as string }],
        },
      ).decision;
      const { token } = api[who];
      for (const [method, path] of READS) {
        expect((await api.call(token, method, path)).status, path).toBe(403);
      }
      for (const [method, path, payload] of WRITES) {
        expect(
          (await api.call(token, method, path, payload)).status,
          path,
        ).toBe(403);
      }
      const answer = await api.call(
        token,
        'POST',
        `/decisions/${created.id}/answers`,
        { version: 1, choice: 'approve' },
      );
      expect(answer.status).toBe(403);
      expect(api.h.authority.decisions.get('ws_test', created.id)?.status).toBe(
        'open',
      );
      expect(packetStatus(m.driver, m.ids[0] as string).authorized).toBe(false);
    },
  );

  it('refuses a human token without the decision scopes', async () => {
    const api = createApi();
    const reader = seedPrincipal(api.db, {
      kind: 'human',
      scopes: ['decision:read'],
    });
    expect((await api.call(reader.token, 'GET', '/decisions')).status).toBe(
      200,
    );
    expect(
      (
        await api.call(reader.token, 'POST', '/decisions/dec_x/answers', {
          version: 1,
          choice: 'approve',
        })
      ).status,
    ).toBe(403);
  });
});

describe('the inbox over HTTP', () => {
  it('creates, lists by priority, reads and answers', async () => {
    const api = createApi();
    const m = blocked(api, 3);
    const [p0, p1, p2] = m.ids as [string, string, string];
    const low = await api.call(
      api.cos.token,
      'POST',
      '/decisions',
      body(m.driver.id, p0, { dedupeKey: 'low', urgency: 'low' }),
    );
    expect(low.status).toBe(201);
    expect(low.body).toMatchObject({
      created: true,
      decision: {
        status: 'open',
        version: 1,
        requiredAuthority: 'human',
        recommendation: {
          alternativeId: 'approve',
          rationale: 'Low risk.',
          by: api.cos.principalId,
        },
        advisory: { confidencePercent: 80 },
        links: [{ missionId: m.driver.id, packetId: p0, status: 'blocked' }],
      },
    });
    const urgent = await api.call(
      api.cos.token,
      'POST',
      '/decisions',
      body(m.driver.id, p1, { dedupeKey: 'urgent', urgency: 'urgent' }),
    );
    await api.call(
      api.cos.token,
      'POST',
      '/decisions',
      body(m.driver.id, p2, { dedupeKey: 'normal' }),
    );

    const list = await api.call(api.owner.token, 'GET', '/decisions');
    expect(
      list.body.decisions.map((d: { dedupeKey: string }) => d.dedupeKey),
    ).toEqual(['urgent', 'normal', 'low']);

    const answered = await api.call(
      api.owner.token,
      'POST',
      `/decisions/${urgent.body.decision.id}/answers`,
      { version: 1, choice: 'approve', note: 'go' },
    );
    expect(answered.status).toBe(200);
    expect(answered.body).toMatchObject({
      applied: true,
      replayed: false,
      branches: [{ missionId: m.driver.id, packetId: p1, status: 'resumed' }],
      decision: {
        status: 'answered',
        effectiveAnswer: {
          version: 1,
          choice: 'approve',
          note: 'go',
          answeredBy: api.owner.principalId,
        },
      },
    });
    expect(packetStatus(m.driver, p1).authorized).toBe(true);
    expect(packetStatus(m.driver, p0).authorized).toBe(false);
    expect(packetStatus(m.driver, p2).authorized).toBe(false);

    const open = await api.call(
      api.owner.token,
      'GET',
      '/decisions?status=open',
    );
    expect(open.body.decisions).toHaveLength(2);
    const done = await api.call(
      api.owner.token,
      'GET',
      '/decisions?status=answered',
    );
    expect(done.body.decisions).toHaveLength(1);
    const detail = await api.call(
      api.cos.token,
      'GET',
      `/decisions/${urgent.body.decision.id}`,
    );
    expect(detail.body.answers).toMatchObject([
      { version: 1, choice: 'approve', answeredBy: api.owner.principalId },
    ]);

    const history = await api.call(
      api.owner.token,
      'GET',
      `/decisions/${urgent.body.decision.id}/history`,
    );
    expect(history.body.items.map((i: { type: string }) => i.type)).toEqual([
      'decision.created',
      'decision.answered',
    ]);
    expect(history.body.items[1]).toMatchObject({
      actorId: api.owner.principalId,
      payload: { effective: true },
    });
  });

  it('links a repeat of a dedupe key to the one item', async () => {
    const api = createApi();
    const m = blocked(api, 2);
    const first = await api.call(
      api.cos.token,
      'POST',
      '/decisions',
      body(m.driver.id, m.ids[0] as string),
    );
    const second = await api.call(
      api.cos.token,
      'POST',
      '/decisions',
      body(m.driver.id, m.ids[1] as string),
    );
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      created: false,
      linked: [{ packetId: m.ids[1] }],
    });
    expect(second.body.decision.id).toBe(first.body.decision.id);
    expect(second.body.decision.links).toHaveLength(2);
    const clash = await api.call(
      api.cos.token,
      'POST',
      '/decisions',
      body(m.driver.id, m.ids[1] as string, { category: 'spend' }),
    );
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('dedupe_conflict');
  });

  it('settles out-of-order answers on the highest version', async () => {
    const api = createApi();
    const m = blocked(api);
    const created = await api.call(
      api.cos.token,
      'POST',
      '/decisions',
      body(m.driver.id, m.ids[0] as string),
    );
    const id = created.body.decision.id;
    const late = await api.call(
      api.owner.token,
      'POST',
      `/decisions/${id}/answers`,
      { version: 2, choice: 'decline' },
    );
    const early = await api.call(
      api.owner.token,
      'POST',
      `/decisions/${id}/answers`,
      { version: 1, choice: 'approve' },
    );
    expect(late.body).toMatchObject({ applied: true, superseded: false });
    expect(early.body).toMatchObject({
      applied: false,
      superseded: true,
      branches: [],
    });
    expect(early.body.decision.effectiveAnswer).toMatchObject({
      version: 2,
      choice: 'decline',
    });
    expect(packetStatus(m.driver, m.ids[0] as string).authorized).toBe(false);
    const repeat = await api.call(
      api.owner.token,
      'POST',
      `/decisions/${id}/answers`,
      { version: 2, choice: 'decline' },
    );
    expect(repeat.body.replayed).toBe(true);
    const clash = await api.call(
      api.owner.token,
      'POST',
      `/decisions/${id}/answers`,
      { version: 2, choice: 'approve' },
    );
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('answer_conflict');
  });

  it.each([
    ['an unknown field', { ...body('msn_x', null), extra: 1 }],
    ['no branches', { ...body('msn_x', null), branches: [] }],
    ['a missing question', { ...body('msn_x', null), question: undefined }],
    ['an unknown category', { ...body('msn_x', null), category: 'whim' }],
    [
      'one alternative',
      { ...body('msn_x', null), alternatives: [{ id: 'a', label: 'A' }] },
    ],
    [
      'a recommendation for no alternative',
      {
        ...body('msn_x', null),
        recommendation: { alternativeId: 'nope', rationale: 'r' },
      },
    ],
    [
      'a bad request action',
      { ...body('msn_x', null), request: { ...REQUEST, action: 'Bad Action' } },
    ],
    [
      'too much confidence',
      { ...body('msn_x', null), advisory: { confidencePercent: 101 } },
    ],
  ])('rejects %s with a 400', async (_name, payload) => {
    const api = createApi();
    const response = await api.call(
      api.cos.token,
      'POST',
      '/decisions',
      payload,
    );
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('validation_failed');
  });

  it('answers 404 for a missing mission, packet or decision, and across workspaces', async () => {
    const api = createApi();
    const m = blocked(api);
    expect(
      (
        await api.call(
          api.cos.token,
          'POST',
          '/decisions',
          body('msn_nope', null),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await api.call(
          api.cos.token,
          'POST',
          '/decisions',
          body(m.driver.id, 'pkt_nope'),
        )
      ).status,
    ).toBe(404);
    const created = await api.call(
      api.cos.token,
      'POST',
      '/decisions',
      body(m.driver.id, m.ids[0] as string),
    );
    const id = created.body.decision.id;
    expect(
      (await api.call(api.owner.token, 'GET', '/decisions/dec_nope')).status,
    ).toBe(404);
    expect(
      (
        await api.call(api.owner.token, 'POST', '/decisions/dec_nope/answers', {
          version: 1,
          choice: 'approve',
        })
      ).status,
    ).toBe(404);
    ensureWorkspace(api.db, 'ws_elsewhere', 'elsewhere');
    const foreign = seedPrincipal(api.db, {
      kind: 'human',
      workspaceId: 'ws_elsewhere',
    });
    expect(
      (await api.call(foreign.token, 'GET', `/decisions/${id}`)).status,
    ).toBe(404);
    expect(
      (
        await api.call(foreign.token, 'POST', `/decisions/${id}/answers`, {
          version: 1,
          choice: 'approve',
        })
      ).status,
    ).toBe(404);
    expect(
      (await api.call(foreign.token, 'GET', '/decisions')).body.decisions,
    ).toEqual([]);
    expect(api.h.authority.decisions.get('ws_test', id)?.status).toBe('open');
  });

  it('rejects an answer that is malformed or names no choice', async () => {
    const api = createApi();
    const m = blocked(api);
    const id = (
      await api.call(
        api.cos.token,
        'POST',
        '/decisions',
        body(m.driver.id, m.ids[0] as string),
      )
    ).body.decision.id;
    for (const payload of [
      {},
      { version: 0, choice: 'approve' },
      { version: 1 },
      { version: 1, choice: 'maybe' },
      { version: 1, choice: 'approve', x: 1 },
    ]) {
      expect(
        (
          await api.call(
            api.owner.token,
            'POST',
            `/decisions/${id}/answers`,
            payload,
          )
        ).status,
      ).toBe(400);
    }
    expect(
      (await api.call(api.owner.token, 'GET', '/decisions?status=nope')).status,
    ).toBe(400);
    expect(
      (await api.call(api.owner.token, 'GET', '/decisions?limit=0')).status,
    ).toBe(400);
  });
});

describe('a Chief of Staff answering over HTTP', () => {
  const delegated = (m: ReturnType<typeof blocked>, extra: object = {}) =>
    body(m.driver.id, m.ids[0] as string, {
      requiredAuthority: 'chief_of_staff',
      request: REQUEST,
      ...extra,
    });

  it('is refused with no delegated rule, and allowed once one covers the request', async () => {
    const api = createApi();
    const m = blocked(api);
    const created = await api.call(
      api.cos.token,
      'POST',
      '/decisions',
      delegated(m),
    );
    const id = created.body.decision.id;
    const refused = await api.call(
      api.cos.token,
      'POST',
      `/decisions/${id}/answers`,
      { version: 1, choice: 'approve' },
    );
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('delegation_required');
    expect(packetStatus(m.driver, m.ids[0] as string).authorized).toBe(false);
    expect(
      (await api.call(api.cos.token, 'GET', '/policy/receipts')).body.receipts,
    ).toMatchObject([
      {
        principalId: api.cos.principalId,
        action: 'scope.extend',
        effect: 'deny',
        code: 'no_matching_grant',
      },
    ]);

    grant(api.h, {
      action: 'scope.extend',
      resource: 'repo:app',
      scope: 'infra',
    });
    const allowed = await api.call(
      api.cos.token,
      'POST',
      `/decisions/${id}/answers`,
      { version: 1, choice: 'approve' },
    );
    expect(allowed.status).toBe(200);
    expect(allowed.body.branches).toMatchObject([{ status: 'resumed' }]);
  });

  it('cannot answer a decision that needs a person', async () => {
    const api = createApi();
    const m = blocked(api);
    grant(api.h, {
      action: 'scope.extend',
      resource: 'repo:app',
      scope: 'infra',
    });
    const created = await api.call(
      api.cos.token,
      'POST',
      '/decisions',
      delegated(m, { requiredAuthority: 'human' }),
    );
    const response = await api.call(
      api.cos.token,
      'POST',
      `/decisions/${created.body.decision.id}/answers`,
      { version: 1, choice: 'approve' },
    );
    expect(response.status).toBe(403);
  });
});

describe('expansions over HTTP', () => {
  const ask = (missionId: string, packetId: string, extra: object = {}) => ({
    missionId,
    packetId,
    action: 'scope.extend',
    resource: 'repo:app',
    scope: 'infra',
    risk: 'low',
    question: 'May this reach into infra?',
    ...extra,
  });

  it('sends a Chief of Staff without a rule to the inbox, and approves one with a rule', async () => {
    const api = createApi();
    const m = blocked(api, 2);
    const held = await api.call(
      api.cos.token,
      'POST',
      '/expansions',
      ask(m.driver.id, m.ids[0] as string, {
        advisory: { confidencePercent: 100 },
      }),
    );
    expect(held.status).toBe(200);
    expect(held.body).toMatchObject({
      tier: 3,
      outcome: 'decision_required',
      created: true,
      evaluation: { effect: 'escalate' },
      decision: {
        requiredAuthority: 'human',
        advisory: { confidencePercent: 100 },
      },
    });
    expect(packetStatus(m.driver, m.ids[0] as string).authorized).toBe(false);

    grant(api.h, {
      action: 'scope.extend',
      resource: 'repo:app',
      scope: 'infra',
    });
    const approved = await api.call(
      api.cos.token,
      'POST',
      '/expansions',
      ask(m.driver.id, m.ids[1] as string),
    );
    expect(approved.body).toMatchObject({
      tier: 2,
      outcome: 'approved',
      evaluation: { effect: 'allow' },
    });
    expect(packetStatus(m.driver, m.ids[1] as string).authorized).toBe(true);
  });

  it('stops at a deny rule and tells the caller', async () => {
    const api = createApi();
    const m = blocked(api);
    await api.call(api.owner.token, 'POST', '/policy/rules', {
      effect: 'deny',
      action: 'scope.extend',
      resource: '*',
      scope: 'infra',
    });
    const denied = await api.call(
      api.cos.token,
      'POST',
      '/expansions',
      ask(m.driver.id, m.ids[0] as string),
    );
    expect(denied.body).toMatchObject({
      tier: 'denied',
      outcome: 'denied',
      evaluation: { code: 'explicit_deny' },
    });
    expect(
      (await api.call(api.owner.token, 'GET', '/decisions?status=all')).body
        .decisions,
    ).toEqual([]);
  });

  it('answers 404 for a mission it cannot find and 400 for a bad request', async () => {
    const api = createApi();
    expect(
      (
        await api.call(
          api.cos.token,
          'POST',
          '/expansions',
          ask('msn_nope', 'pkt_x'),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await api.call(api.cos.token, 'POST', '/expansions', {
          missionId: 'msn_x',
        })
      ).status,
    ).toBe(400);
  });
});
