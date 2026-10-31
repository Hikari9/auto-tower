import { describe, expect, it } from 'vitest';
import {
  createGitHubProvider,
  githubWebhookCodec,
  parseGitHubIssueUrl,
  signGitHubBody,
  verifyGitHubSignature,
} from '../../src/issues/index.js';
import { parsePublicHttpsUrl } from '../../src/issues/url.js';

const REF = parseGitHubIssueUrl('https://github.com/acme/web/issues/5');
if (REF === undefined) {
  throw new Error('fixture');
}

interface Call {
  url: string;
  method: string;
  redirect: string | undefined;
  headers: Record<string, string>;
  body: string | undefined;
}

type Reply =
  | { status: number; body?: unknown; headers?: Record<string, string> }
  | Error;

function fakeFetch(replies: Reply[]) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      redirect: init?.redirect,
      headers: init?.headers as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const reply = replies.shift() ?? { status: 500 };
    if (reply instanceof Error) {
      throw reply;
    }
    const text = reply.body === undefined ? '' : JSON.stringify(reply.body);
    return new Response(text, {
      status: reply.status,
      ...(reply.headers === undefined ? {} : { headers: reply.headers }),
    });
  }) as typeof fetch;
  return { calls, impl };
}

const issueBody = (over: Record<string, unknown> = {}) => ({
  node_id: 'I_node1',
  number: 5,
  state: 'open',
  title: 'A title',
  repository_url: 'https://api.github.com/repos/acme/web',
  ...over,
});

function provider(replies: Reply[], token = 'ghs_secret_token') {
  const f = fakeFetch(replies);
  return { f, p: createGitHubProvider({ token: () => token, fetch: f.impl }) };
}

describe('parseGitHubIssueUrl', () => {
  it('accepts issue URLs only', () => {
    expect(
      parseGitHubIssueUrl('https://github.com/Acme/Web/issues/5/'),
    ).toEqual({
      provider: 'github',
      repo: 'acme/web',
      number: 5,
      url: 'https://github.com/Acme/Web/issues/5',
    });
    for (const bad of [
      'https://github.com/acme/web/pull/5',
      'https://github.com/acme/web/issues/0',
      'https://github.com/acme/web/issues/05x',
      'https://github.com/acme/web/issues/5/extra',
      'https://github.com/acme/../issues/5',
      'https://github.com/acme/web/issues/12345678901',
      'https://gist.github.com/acme/web/issues/5',
      'http://github.com/acme/web/issues/5',
      'https://github.com.evil.test/acme/web/issues/5',
      'https://github.com:444/acme/web/issues/5',
      'https://api.github.com/repos/acme/web/issues/5',
    ]) {
      expect(parseGitHubIssueUrl(bad), bad).toBeUndefined();
    }
  });
});

describe('createGitHubProvider', () => {
  it('reads one issue from the API host only, never following redirects, with the credential', async () => {
    const { f, p } = provider([{ status: 200, body: issueBody() }]);

    const result = await p.getIssue(REF);

    expect(result).toEqual({
      ok: true,
      value: {
        nodeId: 'I_node1',
        repo: 'acme/web',
        number: 5,
        state: 'open',
        title: 'A title',
        openBlockers: null,
      },
    });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toBe(
      'https://api.github.com/repos/acme/web/issues/5',
    );
    expect(f.calls[0]?.redirect).toBe('manual');
    expect(f.calls[0]?.headers.authorization).toBe('Bearer ghs_secret_token');
  });

  it('counts open blockers and reports a missing or forbidden dependencies endpoint as unknown', async () => {
    const withBlockers = provider([
      { status: 200, body: issueBody() },
      {
        status: 200,
        body: [{ state: 'open' }, { state: 'closed' }, { state: 'open' }],
      },
    ]);
    const first = await withBlockers.p.getIssue(REF, { includeBlockers: true });
    expect(first.ok && first.value.openBlockers).toBe(2);
    expect(withBlockers.f.calls[1]?.url).toContain(
      '/issues/5/dependencies/blocked_by',
    );

    const unsupported = provider([
      { status: 200, body: issueBody() },
      { status: 404 },
    ]);
    const second = await unsupported.p.getIssue(REF, { includeBlockers: true });
    expect(second.ok).toBe(true);
    expect(second.ok && second.value.openBlockers).toBeNull();

    const forbidden = provider([
      { status: 200, body: issueBody() },
      { status: 403, body: { message: 'Resource not accessible' } },
    ]);
    const denied = await forbidden.p.getIssue(REF, { includeBlockers: true });
    expect(denied.ok).toBe(true);
    expect(denied.ok && denied.value.openBlockers).toBeNull();

    const limited = provider([
      { status: 200, body: issueBody() },
      { status: 429, headers: { 'retry-after': '30' } },
    ]);
    const slowed = await limited.p.getIssue(REF, { includeBlockers: true });
    expect(slowed.ok).toBe(false);

    const failing = provider([
      { status: 200, body: issueBody() },
      { status: 503 },
    ]);
    const third = await failing.p.getIssue(REF, { includeBlockers: true });
    expect(third.ok).toBe(false);
  });

  it.each([
    [
      'a redirect',
      { status: 301, headers: { location: 'https://evil.test/' } },
      'transferred',
    ],
    ['not found', { status: 404 }, 'not_found'],
    ['gone', { status: 410 }, 'not_found'],
    ['a rejected credential', { status: 401 }, 'permission'],
    [
      'a plain 403',
      { status: 403, body: { message: 'Resource not accessible' } },
      'permission',
    ],
    ['a server error', { status: 502 }, 'unavailable'],
    ['an unexpected 4xx', { status: 422 }, 'invalid_response'],
  ] as Array<[string, Reply, string]>)(
    'maps %s',
    async (_name, reply, kind) => {
      const { p } = provider([reply]);
      const result = await p.getIssue(REF);
      expect(result.ok ? 'ok' : result.error.kind).toBe(kind);
    },
  );

  it('maps a network failure and a timeout to unavailable', async () => {
    const { p } = provider([new Error('ECONNRESET')]);
    const result = await p.getIssue(REF);
    expect(result.ok ? 'ok' : result.error.kind).toBe('unavailable');
  });

  it('reads rate limits: 429, secondary 403 and an exhausted primary limit, with the wait', async () => {
    const reset = String(Math.ceil(Date.now() / 1000) + 90);
    const cases: Array<[Reply, (n: number) => boolean]> = [
      [{ status: 429, headers: { 'retry-after': '45' } }, (n) => n === 45],
      [
        {
          status: 403,
          headers: { 'retry-after': '30' },
          body: { message: 'x' },
        },
        (n) => n === 30,
      ],
      [
        {
          status: 403,
          body: { message: 'You have exceeded a secondary rate limit.' },
        },
        (n) => n === 60,
      ],
      [
        {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset },
        },
        (n) => n >= 85 && n <= 91,
      ],
      [{ status: 429 }, (n) => n === 60],
      [
        { status: 429, headers: { 'retry-after': '999999' } },
        (n) => n === 86_400,
      ],
    ];
    for (const [reply, check] of cases) {
      const { p } = provider([reply]);
      const result = await p.getIssue(REF);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('rate_limited');
        expect(check(result.error.retryAfterSeconds ?? -1)).toBe(true);
      }
    }
  });

  it('refuses a response about a different issue, a pull request or malformed JSON', async () => {
    for (const body of [
      issueBody({ number: 6 }),
      issueBody({ pull_request: {} }),
      issueBody({ state: 'merged' }),
      issueBody({ node_id: undefined }),
      'not an object',
    ]) {
      const { p } = provider([{ status: 200, body }]);
      const result = await p.getIssue(REF);
      expect(result.ok ? 'ok' : result.error.kind).toBe('invalid_response');
    }
    const moved = provider([
      {
        status: 200,
        body: issueBody({
          repository_url: 'https://api.github.com/repos/acme/new-home',
        }),
      },
    ]);
    const result = await moved.p.getIssue(REF);
    expect(result.ok ? 'ok' : result.error.kind).toBe('transferred');
  });

  it('refuses a response that is too large', async () => {
    const { p } = provider([
      { status: 200, body: issueBody({ title: 'x'.repeat(1_100_000) }) },
    ]);
    const result = await p.getIssue(REF);
    expect(result.ok ? 'ok' : result.error.kind).toBe('invalid_response');
  });

  it('closes with a state change and a note carrying the origin marker', async () => {
    const { f, p } = provider([
      { status: 200, body: issueBody({ state: 'closed' }) },
      { status: 201, body: {} },
    ]);

    const result = await p.closeIssue(REF, {
      marker: 'iop_abc123',
      note: 'Closed by Auto Tower for mission msn_1.',
    });

    expect(result).toEqual({ ok: true, value: { commented: true } });
    expect(f.calls[0]).toMatchObject({
      method: 'PATCH',
      url: 'https://api.github.com/repos/acme/web/issues/5',
    });
    expect(JSON.parse(f.calls[0]?.body ?? '{}')).toEqual({
      state: 'closed',
      state_reason: 'completed',
    });
    expect(f.calls[1]?.method).toBe('POST');
    expect(f.calls[1]?.url).toBe(
      'https://api.github.com/repos/acme/web/issues/5/comments',
    );
    expect(JSON.parse(f.calls[1]?.body ?? '{}').body).toContain(
      'tower:origin:iop_abc123',
    );
  });

  it('still reports a close when the note fails, and reports a failed close without a note', async () => {
    const noteFails = provider([{ status: 200, body: {} }, { status: 500 }]);
    expect(
      await noteFails.p.closeIssue(REF, { marker: 'm', note: 'n' }),
    ).toEqual({ ok: true, value: { commented: false } });

    const closeFails = provider([
      { status: 403, body: { message: 'forbidden' } },
    ]);
    const result = await closeFails.p.closeIssue(REF, {
      marker: 'm',
      note: 'n',
    });
    expect(result.ok ? 'ok' : result.error.kind).toBe('permission');
    expect(closeFails.f.calls).toHaveLength(1);
  });

  it('does not put the credential or response text in a failure', async () => {
    const { p } = provider([
      { status: 500, body: { message: 'secret ghs_secret_token leaked' } },
    ]);
    const result = await p.getIssue(REF);
    expect(JSON.stringify(result)).not.toContain('ghs_secret_token');
    expect(JSON.stringify(result)).not.toContain('leaked');
  });

  it('fails closed when the credential cannot be read', async () => {
    const p = createGitHubProvider({
      token: () => {
        throw new Error('no token');
      },
      fetch: fakeFetch([]).impl,
    });
    const result = await p.getIssue(REF);
    expect(result.ok ? 'ok' : result.error.kind).toBe('permission');
  });

  it('refuses an unsafe custom API base', () => {
    for (const apiBase of [
      'http://ghe.example.com',
      'https://127.0.0.1',
      'https://localhost',
      'https://u:p@ghe.example.com',
    ]) {
      expect(
        () => createGitHubProvider({ token: () => 't', apiBase }),
        apiBase,
      ).toThrow(/API base/);
    }
    expect(() =>
      createGitHubProvider({
        token: () => 't',
        apiBase: 'https://ghe.example.com/api/v3',
      }),
    ).not.toThrow();
  });
});

describe('webhook signatures', () => {
  const body = new TextEncoder().encode('{"zen":"hi"}');

  it('accepts only the exact HMAC of the raw body', () => {
    const good = signGitHubBody('s3cret', body);
    expect(verifyGitHubSignature('s3cret', body, good)).toBe(true);
    expect(verifyGitHubSignature('other', body, good)).toBe(false);
    expect(
      verifyGitHubSignature(
        's3cret',
        new TextEncoder().encode('{"zen":"ho"}'),
        good,
      ),
    ).toBe(false);
    for (const bad of [
      null,
      '',
      'sha256=',
      'sha1=abc',
      `${good}0`,
      good.toUpperCase(),
      good.replace('sha256=', ''),
    ]) {
      expect(verifyGitHubSignature('s3cret', body, bad), String(bad)).toBe(
        false,
      );
    }
    expect(verifyGitHubSignature('', body, signGitHubBody('', body))).toBe(
      false,
    );
  });

  it('decodes issue, comment and ping events and ignores the rest', () => {
    const headers = (event: string) => new Headers({ 'x-github-event': event });
    const repo = { full_name: 'Acme/Web' };
    expect(githubWebhookCodec.decode(headers('ping'), {})).toEqual({
      kind: 'ping',
    });
    expect(
      githubWebhookCodec.decode(headers('issues'), {
        action: 'reopened',
        repository: repo,
        issue: { number: 5, node_id: 'N', state: 'open', title: 'T\u0000x' },
      }),
    ).toEqual({
      kind: 'issue',
      action: 'reopened',
      repo: 'acme/web',
      number: 5,
      nodeId: 'N',
      state: 'open',
      title: 'T x',
      identityLost: false,
    });
    expect(
      githubWebhookCodec.decode(headers('issues'), {
        action: 'transferred',
        repository: repo,
        issue: { number: 5 },
      }),
    ).toMatchObject({ identityLost: true });
    expect(
      githubWebhookCodec.decode(headers('issue_comment'), {
        repository: repo,
        issue: { number: 5 },
        comment: { body: 'x\n<!-- tower:origin:iop_9 -->' },
      }),
    ).toEqual({
      kind: 'comment',
      repo: 'acme/web',
      number: 5,
      marker: 'iop_9',
    });
    expect(
      githubWebhookCodec.decode(headers('push'), { repository: repo }),
    ).toBeUndefined();
    expect(
      githubWebhookCodec.decode(headers('issues'), {
        action: 'closed',
        repository: repo,
        issue: { number: 5, pull_request: {} },
      }),
    ).toBeUndefined();
    expect(
      githubWebhookCodec.decode(headers('issues'), {
        action: 'closed',
        repository: { full_name: '../x' },
        issue: { number: 5 },
      }),
    ).toBeUndefined();
    expect(
      githubWebhookCodec.decode(headers('issues'), 'nope'),
    ).toBeUndefined();
  });

  it('reads a delivery id only when it is well formed', () => {
    expect(
      githubWebhookCodec.deliveryId(
        new Headers({ 'x-github-delivery': 'abc-123' }),
      ),
    ).toBe('abc-123');
    expect(
      githubWebhookCodec.deliveryId(
        new Headers({ 'x-github-delivery': 'a b' }),
      ),
    ).toBeUndefined();
    expect(githubWebhookCodec.deliveryId(new Headers())).toBeUndefined();
  });
});

describe('parsePublicHttpsUrl', () => {
  it('drops the fragment and accepts a public https name', () => {
    const parsed = parsePublicHttpsUrl('https://example.com/a/b?x=1#frag');
    expect(parsed.ok && parsed.url.href).toBe('https://example.com/a/b?x=1');
  });

  it('refuses whitespace, control characters and overlong input', () => {
    for (const bad of [
      ' https://example.com',
      'https://example.com ',
      'https://exa\nmple.com',
      `https://example.com/${'a'.repeat(2000)}`,
    ]) {
      expect(parsePublicHttpsUrl(bad).ok, bad.slice(0, 30)).toBe(false);
    }
  });
});
