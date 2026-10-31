import { describe, expect, it } from 'vitest';
import { ROUTES } from '../../src/api/app.js';
import { signGitHubBody } from '../../src/issues/index.js';
import {
  completeMission,
  createIssueApi,
  ISSUE_URL,
  type IssueApi,
  missionWithLinks,
  WEBHOOK_SECRET,
} from '../issues/helpers.js';

const encode = (value: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value));

const PAYLOAD = (action = 'reopened') => ({
  action,
  repository: { full_name: 'acme/web' },
  issue: {
    number: 1,
    node_id: 'node_acme/web_1',
    state: action === 'closed' ? 'closed' : 'open',
    title: 'Fix the thing',
  },
});

function send(
  api: IssueApi,
  body: Uint8Array,
  options: {
    secret?: string;
    signature?: string | null;
    delivery?: string | null;
    event?: string;
    path?: string;
  } = {},
) {
  const signature =
    options.signature === undefined
      ? signGitHubBody(options.secret ?? WEBHOOK_SECRET, body)
      : options.signature;
  const delivery =
    options.delivery === undefined
      ? `del-${Math.random().toString(16).slice(2)}`
      : options.delivery;
  return api.raw(options.path ?? '/webhooks/github/ws_test', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': options.event ?? 'issues',
      ...(delivery === null ? {} : { 'x-github-delivery': delivery }),
      ...(signature === null ? {} : { 'x-hub-signature-256': signature }),
    },
    body,
  });
}

async function completedMission(api: IssueApi) {
  const h = api.h;
  h.github.add(ISSUE_URL);
  h.issues.setSyncConfig(h.ctx(h.owner), {
    provider: 'github',
    repo: 'acme/web',
    mode: 'observe',
  });
  const driver = missionWithLinks(h);
  await h.issues.verifyMission(h.ctx(h.owner), driver.id);
  h.github.issue(ISSUE_URL).state = 'closed';
  await h.issues.verifyMission(h.ctx(h.owner), driver.id);
  completeMission(driver);
  return driver;
}

describe('the webhook route is opt-in', () => {
  it('is not part of the shipped routes, so /health stays the only public route', () => {
    expect(ROUTES.filter((r) => r.path.startsWith('/webhooks'))).toEqual([]);
    expect(
      ROUTES.filter(
        (r) => 'public' in r.access && r.access.public === true,
      ).map((r) => r.path),
    ).toEqual(['/health']);
  });

  it('answers 404 when the host supplies no webhook settings', async () => {
    const api = createIssueApi({ webhooks: false });
    const res = await send(api, encode(PAYLOAD()));
    expect(res.status).toBe(404);
  });
});

describe('signature and delivery checks', () => {
  it('answers 401 for a missing, malformed or wrong signature and changes nothing', async () => {
    const api = createIssueApi();
    const driver = await completedMission(api);
    const body = encode(PAYLOAD());

    for (const options of [
      { signature: null },
      { signature: 'sha256=zz' },
      { signature: signGitHubBody('wrong-secret', body) },
      { signature: signGitHubBody(WEBHOOK_SECRET, encode(PAYLOAD('closed'))) },
      {
        signature: signGitHubBody(WEBHOOK_SECRET, body).replace(
          'sha256=',
          'sha1=',
        ),
      },
    ]) {
      const res = await send(api, body, options);
      expect(res.status, JSON.stringify(options)).toBe(401);
      expect(await res.json()).toEqual({
        error: {
          code: 'invalid_signature',
          message: 'The webhook signature is not valid',
        },
      });
    }
    expect(driver.refresh().state).toBe('completed');
    expect(api.h.db.get('SELECT 1 FROM webhook_deliveries')).toBeUndefined();
  });

  it('answers an unknown workspace or provider exactly like a bad signature', async () => {
    const api = createIssueApi();
    const body = encode(PAYLOAD());
    const expected = await (await send(api, body, { signature: null })).json();
    for (const path of [
      '/webhooks/github/ws_nope',
      '/webhooks/gitlab/ws_test',
    ]) {
      const res = await send(api, body, { path });
      expect(res.status, path).toBe(401);
      expect(await res.json()).toEqual(expected);
    }
  });

  it('does not let a forged request use up a delivery id', async () => {
    const api = createIssueApi();
    await completedMission(api);
    const body = encode(PAYLOAD());

    expect(
      (
        await send(api, body, {
          delivery: 'D-1',
          signature: 'sha256='.concat('0'.repeat(64)),
        })
      ).status,
    ).toBe(401);
    const real = await send(api, body, { delivery: 'D-1' });

    expect(real.status).toBe(200);
    expect(((await real.json()) as { status: string }).status).toBe(
      'processed',
    );
  });

  it('ignores a replayed delivery id', async () => {
    const api = createIssueApi();
    const driver = await completedMission(api);
    const body = encode(PAYLOAD());

    const first = await send(api, body, { delivery: 'D-2' });
    const second = await send(api, body, { delivery: 'D-2' });

    expect(((await first.json()) as { status: string }).status).toBe(
      'processed',
    );
    expect(((await second.json()) as { status: string }).status).toBe(
      'duplicate',
    );
    expect(
      api.h.issues.discrepancies('ws_test', driver.id, 'all'),
    ).toHaveLength(1);
  });

  it('gives a captured signed body no second effect when it is replayed under a new delivery id', async () => {
    const api = createIssueApi();
    const driver = await completedMission(api);
    const body = encode(PAYLOAD());
    const first = await send(api, body, { delivery: 'D-A' });
    const history = api.h.issues.history('ws_test', driver.id, {
      afterSeq: 0,
      limit: 100,
    }).length;
    // The attacker has the body and its valid signature, and picks fresh delivery ids.
    const replays = await Promise.all(
      ['D-B', 'D-C', 'D-D'].map((id) => send(api, body, { delivery: id })),
    );

    expect(((await first.json()) as { status: string }).status).toBe(
      'processed',
    );
    for (const replay of replays) {
      expect(replay.status).toBe(200);
      expect(((await replay.json()) as { status: string }).status).toBe(
        'duplicate',
      );
    }
    expect(
      api.h.issues.discrepancies('ws_test', driver.id, 'all'),
    ).toHaveLength(1);
    expect(
      api.h.issues.history('ws_test', driver.id, { afterSeq: 0, limit: 100 }),
    ).toHaveLength(history);
    expect(
      api.h.db.get<{ n: number }>(
        'SELECT COUNT(*) AS n FROM webhook_deliveries',
      )?.n,
    ).toBe(1);
  });

  it('still processes a different signed body under a new delivery id', async () => {
    const api = createIssueApi();
    const driver = await completedMission(api);
    await send(api, encode(PAYLOAD('reopened')), { delivery: 'D-1' });
    const other = await send(api, encode(PAYLOAD('closed')), {
      delivery: 'D-2',
    });
    expect(((await other.json()) as { status: string }).status).toBe(
      'processed',
    );
    expect(driver.refresh().state).toBeDefined();
  });

  it('refuses a verified request without a delivery id, with invalid JSON, or that is too large', async () => {
    const api = createIssueApi();
    const body = encode(PAYLOAD());

    expect((await send(api, body, { delivery: null })).status).toBe(400);
    const junk = new TextEncoder().encode('{not json');
    expect((await send(api, junk)).status).toBe(400);
    const big = new Uint8Array(1_000_001);
    const res = await send(api, big);
    expect(res.status).toBe(413);
  });

  it('answers 503, saying nothing about why, when the host actor is not a provider adapter here', async () => {
    const api = createIssueApi({ webhookActor: 'prn_owner' });
    const res = await send(api, encode(PAYLOAD()));
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain('prn_owner');
  });
});

describe('what a verified delivery does', () => {
  it('records a reopen after completion under the adapter and moves the mission to needs-attention', async () => {
    const api = createIssueApi();
    const driver = await completedMission(api);
    const calls = {
      get: api.h.github.getCalls,
      close: api.h.github.closeCalls,
    };

    const res = await send(api, encode(PAYLOAD('reopened')));

    expect(res.status).toBe(200);
    expect(driver.refresh().state).toBe('needs-attention');
    expect(
      api.h.issues.discrepancies('ws_test', driver.id, 'open')[0],
    ).toMatchObject({
      kind: 'reopened',
      source: 'webhook',
      detectedBy: api.h.provider.id,
    });
    expect({
      get: api.h.github.getCalls,
      close: api.h.github.closeCalls,
    }).toEqual(calls);
  });

  it('answers a ping, an untracked issue and an event it does not use', async () => {
    const api = createIssueApi();
    const status = async (res: Response) =>
      ((await res.json()) as { status: string }).status;

    expect(
      await status(await send(api, encode({ zen: 'hi' }), { event: 'ping' })),
    ).toBe('pong');
    expect(await status(await send(api, encode(PAYLOAD('closed'))))).toBe(
      'untracked',
    );
    expect(
      await status(await send(api, encode({ ref: 'main' }), { event: 'push' })),
    ).toBe('ignored');
  });

  it('needs the exact bytes: one changed byte is a bad signature', async () => {
    const api = createIssueApi();
    const body = encode(PAYLOAD());
    const signature = signGitHubBody(WEBHOOK_SECRET, body);
    const changed = new Uint8Array(body);
    changed[changed.length - 2] = (changed[changed.length - 2] ?? 0) ^ 1;

    expect((await send(api, changed, { signature })).status).toBe(401);
  });
});
