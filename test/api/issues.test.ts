import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { issueToken } from '../../src/auth/tokens.js';
import { openTestDatabase, seedPrincipal } from '../helpers/tower.js';
import {
  createIssueApi,
  ISSUE_URL,
  ISSUE_URL_2,
  type IssueApi,
  missionWithLinks,
} from '../issues/helpers.js';

const CLOSE_RULE = {
  action: 'issue.close',
  resource: 'github:acme/web#*',
  scope: 'repo:acme/web',
  maxRisk: 'high',
  grantee: { kind: 'chief_of_staff' },
};

async function setupClosable(api: IssueApi) {
  api.h.github.add(ISSUE_URL);
  expect(
    (
      await api.call(api.owner, 'PUT', '/issues/sync-config', {
        repo: 'acme/web',
        mode: 'bidirectional',
      })
    ).status,
  ).toBe(200);
  expect(
    (await api.call(api.owner, 'POST', '/policy/rules', CLOSE_RULE)).status,
  ).toBe(201);
  return missionWithLinks(api.h);
}

describe('access to issue routes', () => {
  const MISSION = '/missions/msn_x';
  const ALL: Array<[string, string, object?]> = [
    ['GET', `${MISSION}/issue-links`],
    ['POST', `${MISSION}/issue-links`, {}],
    ['POST', `${MISSION}/issue-links/verify`, {}],
    ['POST', `${MISSION}/issue-links/close`, {}],
    ['GET', `${MISSION}/issue-links/history`],
    ['GET', `${MISSION}/issue-discrepancies`],
    ['POST', `${MISSION}/issue-discrepancies/d/resolve`, { note: 'x' }],
    ['POST', `${MISSION}/issue-links/l/exemption`, { reason: 'x' }],
    ['POST', `${MISSION}/issue-links/l/exemption/approve`, {}],
    ['POST', `${MISSION}/issue-links/l/exemption/revoke`, {}],
    ['GET', '/issues/sync-config'],
    ['PUT', '/issues/sync-config', { repo: '*', mode: 'observe' }],
    ['POST', '/issues/poll', {}],
  ];

  it('demands a token on every route', async () => {
    const api = createIssueApi();
    for (const [method, path, body] of ALL) {
      expect(
        (await api.call(undefined, method, path, body)).status,
        `${method} ${path}`,
      ).toBe(401);
    }
  });

  it('keeps runners out of every write route and Chief of Staff out of sync config and polling', async () => {
    const api = createIssueApi();
    for (const [method, path, body] of ALL.filter(([m]) => m !== 'GET')) {
      expect(
        (await api.call(api.runner, method, path, body)).status,
        `runner ${method} ${path}`,
      ).toBe(403);
    }
    expect(
      (
        await api.call(api.cos, 'PUT', '/issues/sync-config', {
          repo: '*',
          mode: 'bidirectional',
        })
      ).status,
    ).toBe(403);
    expect((await api.call(api.cos, 'POST', '/issues/poll', {})).status).toBe(
      403,
    );
    expect(api.h.issues.getSyncConfigs('ws_test')).toEqual([]);
  });

  it('lets a provider adapter poll and read, but not change links, close or approve', async () => {
    const api = createIssueApi();
    expect(
      (await api.call(api.provider, 'POST', '/issues/poll', {})).status,
    ).toBe(200);
    expect(
      (
        await api.call(
          api.provider,
          'POST',
          '/missions/msn_x/issue-links/close',
          {},
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await api.call(
          api.provider,
          'POST',
          '/missions/msn_x/issue-links/l/exemption/approve',
          {},
        )
      ).status,
    ).toBe(403);
  });

  it('does not show another workspace a mission or its links', async () => {
    const api = createIssueApi();
    const driver = missionWithLinks(api.h);
    const other = seedPrincipal(api.h.db, {
      kind: 'human',
      workspaceId: 'ws_other',
    });

    const res = await api.call(
      other.token,
      'GET',
      `/missions/${driver.id}/issue-links`,
    );

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('mission_not_found');
  });
});

describe('links over HTTP', () => {
  it('adds a normalized link, refuses unsafe ones and unknown fields, and renders untrusted text apart', async () => {
    const api = createIssueApi();
    const driver = missionWithLinks(api.h, [], 'draft');
    const add = (body: object) =>
      api.call(api.owner, 'POST', `/missions/${driver.id}/issue-links`, {
        expectedVersion: driver.refresh().version,
        classification: 'required',
        ...body,
      });

    const ok = await add({
      url: `${ISSUE_URL}?tab=1#x`,
      title: 'My <script>alert(1)</script> link',
    });
    expect(ok.status).toBe(201);
    expect(ok.body.link.url).toBe(ISSUE_URL);
    expect(ok.body.link.untrusted.linkTitle).toBe(
      'My <script>alert(1)</script> link',
    );

    for (const url of [
      'http://github.com/acme/web/issues/2',
      'https://127.0.0.1/x',
      'https://[::1]/x',
      'file:///etc/passwd',
    ]) {
      const bad = await add({ url });
      expect(bad.status, url).toBe(400);
      expect(bad.body.error.code).toBe('validation_failed');
      expect(bad.body.error.details.issues[0].path).toBe('url');
    }
    expect((await add({ url: ISSUE_URL_2, extra: 1 })).status).toBe(400);

    const listed = await api.call(
      api.owner,
      'GET',
      `/missions/${driver.id}/issue-links`,
    );
    expect(listed.status).toBe(200);
    expect(listed.body.links).toHaveLength(1);
  });

  it('serves links as JSON with nosniff', async () => {
    const api = createIssueApi();
    const driver = missionWithLinks(api.h);
    const res = await api.raw(`/missions/${driver.id}/issue-links`, {
      headers: { authorization: `Bearer ${api.owner}` },
    });
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('sync configuration over HTTP', () => {
  it('is set by a person, read by anyone with mission:read, and validated', async () => {
    const api = createIssueApi();

    const put = await api.call(api.owner, 'PUT', '/issues/sync-config', {
      repo: 'Acme/Web',
      mode: 'observe',
      readScope: true,
      writeScope: false,
    });
    expect(put.status).toBe(200);
    expect(put.body.config).toMatchObject({
      repo: 'acme/web',
      mode: 'observe',
      readScope: true,
      writeScope: false,
    });
    expect(
      (await api.call(api.cos, 'GET', '/issues/sync-config')).body.configs,
    ).toHaveLength(1);

    for (const body of [
      { repo: 'acme/web', mode: 'observe', writeScope: true },
      { repo: 'acme/web', mode: 'link-only', readScope: true },
      { repo: 'acme/web', mode: 'sync-everything' },
      { repo: '../etc', mode: 'observe' },
      { repo: 'acme/web', mode: 'observe', extra: true },
    ]) {
      expect(
        (await api.call(api.owner, 'PUT', '/issues/sync-config', body)).status,
        JSON.stringify(body),
      ).toBe(400);
    }
  });
});

describe('closing and completing over HTTP', () => {
  it('blocks completion with a named guard, then completes after an authorized close', async () => {
    const api = createIssueApi();
    const driver = await setupClosable(api);
    const evidence = await api.call(
      api.owner,
      'POST',
      `/missions/${driver.id}/outcome-verification`,
      {
        expectedVersion: driver.refresh().version,
        evidenceRefs: ['ev:1'],
      },
    );
    expect(evidence.status).toBe(200);
    const complete = () =>
      api.call(api.owner, 'POST', `/missions/${driver.id}/transitions`, {
        expectedVersion: driver.refresh().version,
        to: 'completed',
      });

    const blocked = await complete();
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.code).toBe('completion_guard_failed');
    expect(
      blocked.body.error.details.failures.map(
        (f: { guard: string }) => f.guard,
      ),
    ).toContain('required-issues-closed');

    const closed = await api.call(
      api.cos,
      'POST',
      `/missions/${driver.id}/issue-links/close`,
      {},
    );
    expect(closed.status).toBe(200);
    expect(closed.body.results[0].status).toBe('closed');
    expect(closed.body.satisfied).toBe(true);

    expect((await complete()).status).toBe(200);
  });

  it('answers a missing grant as an outcome with the policy reference, and writes nothing', async () => {
    const api = createIssueApi();
    api.h.github.add(ISSUE_URL);
    await api.call(api.owner, 'PUT', '/issues/sync-config', {
      repo: 'acme/web',
      mode: 'bidirectional',
    });
    const driver = missionWithLinks(api.h);

    const res = await api.call(
      api.cos,
      'POST',
      `/missions/${driver.id}/issue-links/close`,
      {},
    );

    expect(res.status).toBe(200);
    expect(res.body.results[0]).toMatchObject({ status: 'policy_denied' });
    expect(res.body.results[0].policyRef).toMatch(/^policy:v/);
    expect(api.h.github.closeCalls).toBe(0);
  });

  it('reports a provider failure as reconciling with a discrepancy a person can resolve', async () => {
    const api = createIssueApi();
    const driver = await setupClosable(api);
    api.h.github.closeFailures.push({
      kind: 'rate_limited',
      message: 'limited',
      retryAfterSeconds: 90,
    });

    const res = await api.call(
      api.cos,
      'POST',
      `/missions/${driver.id}/issue-links/close`,
      {},
    );

    expect(res.body.state).toBe('reconciling');
    expect(res.body.results[0]).toMatchObject({
      status: 'failed',
      discrepancy: 'rate_limited',
    });
    const list = await api.call(
      api.cos,
      'GET',
      `/missions/${driver.id}/issue-discrepancies`,
    );
    const found = list.body.discrepancies[0];
    expect(found).toMatchObject({
      kind: 'rate_limited',
      requiresAttention: true,
      retryAfterSeconds: 90,
    });

    const resolvePath = `/missions/${driver.id}/issue-discrepancies/${found.id}/resolve`;
    expect(
      (await api.call(api.cos, 'POST', resolvePath, { note: 'looked' })).status,
    ).toBe(403);
    const resolved = await api.call(api.owner, 'POST', resolvePath, {
      note: 'looked',
    });
    expect(resolved.status).toBe(200);
    expect(resolved.body.state).toBe('verifying');
    expect(
      (await api.call(api.owner, 'POST', resolvePath, { note: 'again' }))
        .status,
    ).toBe(409);
    expect(
      (
        await api.call(
          api.owner,
          'GET',
          `/missions/${driver.id}/issue-discrepancies`,
        )
      ).body.discrepancies,
    ).toEqual([]);
    expect(
      (
        await api.call(
          api.owner,
          'GET',
          `/missions/${driver.id}/issue-discrepancies?status=all`,
        )
      ).body.discrepancies,
    ).toHaveLength(1);
    expect(
      (
        await api.call(
          api.owner,
          'GET',
          `/missions/${driver.id}/issue-discrepancies?status=bogus`,
        )
      ).status,
    ).toBe(400);
  });

  it('refuses to close an optional link by name, and a mission that is not ready for it', async () => {
    const api = createIssueApi();
    const driver = await setupClosable(api);
    api.h.github.add(ISSUE_URL_2);
    const optional = missionWithLinks(api.h, [
      { url: ISSUE_URL_2, classification: 'optional' },
    ]);

    const named = await api.call(
      api.cos,
      'POST',
      `/missions/${optional.id}/issue-links/close`,
      { urls: [ISSUE_URL_2] },
    );
    expect(named.status).toBe(409);
    expect(named.body.error.code).toBe('link_not_required');

    const draft = missionWithLinks(api.h, [{ url: ISSUE_URL }], 'draft');
    const early = await api.call(
      api.cos,
      'POST',
      `/missions/${draft.id}/issue-links/close`,
      {},
    );
    expect(early.status).toBe(409);
    expect(early.body.error.code).toBe('mission_not_closable');
    expect(api.h.github.closeCalls).toBe(0);
    expect(driver.id).toBeDefined();
  });

  it('exemptions: Chief of Staff may ask, only a person approves', async () => {
    const api = createIssueApi();
    const driver = missionWithLinks(api.h);
    const link = api.h.issues.listLinks('ws_test', driver.id)[0];
    const base = `/missions/${driver.id}/issue-links/${link?.id}/exemption`;
    driver.verifyOutcome();

    expect(
      (await api.call(api.cos, 'POST', base, { reason: 'tracks follow-up' }))
        .status,
    ).toBe(200);
    expect(
      (await api.call(api.cos, 'POST', `${base}/approve`, {})).status,
    ).toBe(403);
    expect(
      (await api.call(api.owner, 'POST', `${base}/approve`, {})).body.link
        .exemption.status,
    ).toBe('approved');

    const done = await api.call(
      api.owner,
      'POST',
      `/missions/${driver.id}/transitions`,
      {
        expectedVersion: driver.refresh().version,
        to: 'completed',
      },
    );
    expect(done.status).toBe(200);
    const history = await api.call(
      api.owner,
      'GET',
      `/missions/${driver.id}/issue-links/history`,
    );
    expect(history.body.items.map((i: { type: string }) => i.type)).toEqual(
      expect.arrayContaining(['exemption_requested', 'exemption_approved']),
    );
  });

  it('polls as a provider adapter and records the drift', async () => {
    const api = createIssueApi();
    const driver = await setupClosable(api);
    await api.call(
      api.cos,
      'POST',
      `/missions/${driver.id}/issue-links/close`,
      {},
    );
    driver.verifyOutcome();
    driver.go('completed');
    api.h.github.issue(ISSUE_URL).state = 'open';

    const res = await api.call(api.provider, 'POST', '/issues/poll', {});

    expect(res.status).toBe(200);
    expect(res.body.discrepancies).toBe(1);
    expect(driver.refresh().state).toBe('needs-attention');
  });
});

describe('default wiring', () => {
  it('registers the completion guard before the first request, with no issue routes touched', async () => {
    const db = openTestDatabase();
    const owner = seedPrincipal(db, { kind: 'human' });
    const app = createApp({ db });
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await app.request(path, {
        method,
        headers: {
          authorization: `Bearer ${owner.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return {
        status: res.status,
        body: (await res.json()) as {
          error?: { code: string };
          mission?: { id: string; version: number };
        },
      };
    };
    const created = await call('POST', '/missions', {
      title: 'Ship',
      intent: 'Ship it',
      outcome: 'Shipped',
      links: [{ url: ISSUE_URL, classification: 'required' }],
    });
    const mission = created.body.mission;
    let version = mission?.version ?? 0;
    for (const to of ['ready', 'verifying']) {
      version =
        (
          await call('POST', `/missions/${mission?.id}/transitions`, {
            expectedVersion: version,
            to,
          })
        ).body.mission?.version ?? version;
    }
    version =
      (
        await call('POST', `/missions/${mission?.id}/outcome-verification`, {
          expectedVersion: version,
          evidenceRefs: ['ev'],
        })
      ).body.mission?.version ?? version;

    const done = await call('POST', `/missions/${mission?.id}/transitions`, {
      expectedVersion: version,
      to: 'completed',
    });

    expect(done.status).toBe(409);
    expect(done.body.error?.code).toBe('completion_guard_failed');
  });

  it('keeps the shipped token for an adapter distinct from a human token', () => {
    const db = openTestDatabase();
    const adapter = seedPrincipal(db, { kind: 'provider_adapter' });
    expect(() =>
      issueToken(db, {
        principalId: adapter.principalId,
        scopes: ['mission:write'],
      }),
    ).toThrow();
  });
});
