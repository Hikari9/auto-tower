import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { officeRunnerEngine } from '../../src/adapters/office/engine.js';
import { parseCli, UsageError } from '../../src/runner/cli.js';
import { classifyError } from '../../src/runner/failure.js';
import { TowerRunner } from '../../src/runner/runner.js';
import {
  createFileStateStore,
  createMemoryStateStore,
  type StateStore,
} from '../../src/runner/state.js';
import {
  createHttpTransport,
  type Transport,
  TransportError,
} from '../../src/runner/transport.js';
import { FakeOfficeEngine, FakeWorld } from '../adapters/office/fake-engine.js';
import {
  createFleetHarness,
  DIGEST,
  type FleetHarness,
  VERSION,
} from '../fleet/helpers.js';

function harnessTransport(
  h: FleetHarness,
  wrap?: (
    path: string,
    body: unknown,
  ) => { status: number; body: unknown } | undefined,
): Transport {
  return async ({ method, path, body, token }) => {
    const replaced = wrap?.(path, body);
    if (replaced !== undefined) {
      return replaced;
    }
    return h.call(token, method, path, body);
  };
}

async function enroll(
  h: FleetHarness,
  store: StateStore,
  engine: ConstructorParameters<typeof TowerRunner>[0]['engine'],
  transport: Transport = harnessTransport(h),
): Promise<TowerRunner> {
  const enrolled = await h.enroll({ maxConcurrent: 1 });
  const runner = new TowerRunner({
    transport,
    engine,
    store,
    binding: { version: VERSION, buildDigest: DIGEST },
  });
  await runner.register(enrolled.body.enrollment.token);
  return runner;
}

describe('a receipt refusal is parked or retried by its kind', () => {
  /** Counts receipt POSTs and answers them with the given status until told otherwise. */
  function receiptRefusals(
    h: FleetHarness,
    status: number,
    code: string,
    until?: { count: number },
  ) {
    let posts = 0;
    const transport = harnessTransport(h, (path) => {
      if (path.endsWith('/receipts')) {
        posts += 1;
        if (until !== undefined && posts > until.count) {
          return undefined;
        }
        return { status, body: { error: { code, message: 'refused' } } };
      }
      return undefined;
    });
    return { transport, posts: () => posts };
  }

  it('parks a permanent refusal: the receipt is not resent, and the poll still claims', async () => {
    const h = createFleetHarness();
    h.mission([{ title: 'A', scope: ['repo:a'] }]);
    const engine = officeRunnerEngine(
      new FakeOfficeEngine(new FakeWorld(), { steps: 1 }),
    );
    const refusals = receiptRefusals(h, 400, 'invalid');
    let claims = 0;
    const transport: Transport = (request) => {
      if (request.path === '/runners/claims') {
        claims += 1;
      }
      return refusals.transport(request);
    };
    const store = createMemoryStateStore();
    const runner = await enroll(h, store, engine, transport);
    await runner.pollOnce();
    await runner.drain();
    const afterFirst = refusals.posts();
    const second = await runner.pollOnce();
    expect(second.receiptsSent).toEqual([]);
    expect(refusals.posts()).toBe(afterFirst + 1);
    // Parked: the next poll does not send the receipt again, and it still reaches the claim.
    const claimsBefore = claims;
    await runner.pollOnce();
    expect(refusals.posts()).toBe(afterFirst + 1);
    expect(claims).toBe(claimsBefore + 1);
    expect(Object.keys(store.load()?.leases ?? {})).toHaveLength(1);
  });

  it.each([429, 503])(
    'retries a transient %i on the next poll, without failing the poll or parking',
    async (status) => {
      const h = createFleetHarness();
      const mission = h.mission([{ title: 'A', scope: ['repo:a'] }]);
      const engine = officeRunnerEngine(
        new FakeOfficeEngine(new FakeWorld(), { steps: 1 }),
      );
      // The first two answers are transient: the job's own send, then a poll's resend.
      const refusals = receiptRefusals(h, status, 'unavailable', { count: 2 });
      const store = createMemoryStateStore();
      const runner = await enroll(h, store, engine, refusals.transport);
      await runner.pollOnce();
      await runner.drain();
      // The poll's resend meets the second transient answer. The poll still completes, and nothing is parked.
      const middle = await runner.pollOnce();
      expect(middle.receiptsSent).toEqual([]);
      // The next poll sends the same receipt, and Tower accepts it.
      const retried = await runner.pollOnce();
      expect(retried.receiptsSent).toHaveLength(1);
      expect(refusals.posts()).toBe(3);
      expect(h.getMission(mission.id).packets[0]?.status).toBe('reported');
    },
  );
});

describe('a refused progress write takes the path its code names', () => {
  /** Answers progress POSTs with the given refusal, and everything else normally. */
  function progressRefused(h: FleetHarness, status: number, code: string) {
    return harnessTransport(h, (path) =>
      path.endsWith('/progress')
        ? { status, body: { error: { code, message: 'refused' } } }
        : undefined,
    );
  }

  it('drops the lease on lease_fenced, and logs the reason', async () => {
    const h = createFleetHarness();
    h.mission([{ title: 'A', scope: ['repo:a'] }]);
    const fake = new FakeOfficeEngine(new FakeWorld(), { steps: 2 });
    const store = createMemoryStateStore();
    const lines: string[] = [];
    const enrolled = await h.enroll({ maxConcurrent: 1 });
    const runner = new TowerRunner({
      transport: progressRefused(h, 409, 'lease_fenced'),
      engine: officeRunnerEngine(fake),
      store,
      binding: { version: VERSION, buildDigest: DIGEST },
      log: (line) => lines.push(line),
    });
    await runner.register(enrolled.body.enrollment.token);
    const poll = await runner.pollOnce();
    await runner.drain();
    expect(poll.started).toHaveLength(1);
    expect(store.load()?.leases).toEqual({});
    expect(lines.some((line) => /dropped: lease_fenced/.test(line))).toBe(true);
  });

  it('returns the lease to recovery on lease_expired, and keeps it', async () => {
    const h = createFleetHarness();
    h.mission([{ title: 'A', scope: ['repo:a'] }]);
    const fake = new FakeOfficeEngine(new FakeWorld(), { steps: 2 });
    const store = createMemoryStateStore();
    const runner = await enroll(
      h,
      store,
      officeRunnerEngine(fake),
      progressRefused(h, 409, 'lease_expired'),
    );
    await runner.pollOnce();
    await runner.drain();
    const leases = Object.values(store.load()?.leases ?? {});
    expect(leases).toHaveLength(1);
    expect(leases[0]?.phase).toBe('reconcile');
  });

  it('fails the attempt, rather than dropping it, on a refusal that is not about the lease', async () => {
    const h = createFleetHarness();
    const mission = h.mission([{ title: 'A', scope: ['repo:a'] }]);
    const fake = new FakeOfficeEngine(new FakeWorld(), { steps: 2 });
    const runner = await enroll(
      h,
      createMemoryStateStore(),
      officeRunnerEngine(fake),
      progressRefused(h, 400, 'invalid'),
    );
    await runner.pollOnce();
    await runner.drain();
    expect(h.getMission(mission.id).attempts[0]?.report?.outcome).toBe(
      'failed',
    );
  });
});

describe('a fatal refusal from a running job reaches the caller', () => {
  it('raises runner_quarantined from the job while run() sleeps, and the claims still succeed', async () => {
    const h = createFleetHarness();
    h.mission([{ title: 'A', scope: ['repo:a'] }]);
    const fake = new FakeOfficeEngine(new FakeWorld(), { steps: 2 });
    // Every progress write is refused as quarantined. The job's first receipt is refused too, once,
    // so the fatal error can only come from the job. A later poll would resend the receipt and succeed.
    let receipts = 0;
    const transport = harnessTransport(h, (path) => {
      if (path.endsWith('/progress')) {
        return {
          status: 403,
          body: {
            error: { code: 'runner_quarantined', message: 'quarantined' },
          },
        };
      }
      if (path.endsWith('/receipts')) {
        receipts += 1;
        if (receipts === 1) {
          return {
            status: 403,
            body: {
              error: { code: 'runner_quarantined', message: 'quarantined' },
            },
          };
        }
      }
      return undefined;
    });
    const runner = await enroll(
      h,
      createMemoryStateStore(),
      officeRunnerEngine(fake),
      transport,
    );
    // run() starts first, so the job's refusal arrives while run() is sleeping between polls.
    const bound = new AbortController();
    const timer = setTimeout(() => bound.abort(), 2_000);
    try {
      await expect(runner.run(bound.signal)).rejects.toMatchObject({
        code: 'runner_quarantined',
      });
    } finally {
      clearTimeout(timer);
      await runner.drain();
    }
  });
});

describe('a stopping runner starts no job', () => {
  it('does not run an assignment that arrives after stop(), and records no lease for it', async () => {
    const h = createFleetHarness();
    h.mission([{ title: 'A', scope: ['repo:a'] }]);
    const fake = new FakeOfficeEngine(new FakeWorld(), { steps: 1 });
    const store = createMemoryStateStore();
    const runner = await enroll(h, store, officeRunnerEngine(fake));
    runner.stop();
    const report = await runner.pollOnce();
    await runner.drain();
    expect(fake.runs).toHaveLength(0);
    expect(report.started).toEqual([]);
    expect(store.load()?.leases).toEqual({});
  });
});

describe('a re-fenced lease waits for the old run to end', () => {
  it('never has two engine runs at once in the same process', async () => {
    const h = createFleetHarness();
    h.mission([{ title: 'A', scope: ['repo:a'] }]);
    const fake = new FakeOfficeEngine(new FakeWorld(), {
      steps: 2,
      stallAfterMutation: { step: 1, abortGraceMs: 150 },
    });
    const runner = await enroll(
      h,
      createMemoryStateStore(),
      officeRunnerEngine(fake),
    );
    await runner.pollOnce();
    await fake.stallReached;
    // The runner goes quiet past the lease TTL, so Tower moves the lease to recovery.
    h.clock.advance(61_000);
    await runner.pollOnce();
    await runner.drain();
    expect(fake.maxActive).toBe(1);
    expect(fake.runs).toHaveLength(2);
  });
});

describe('the transport limits what it reads', () => {
  it('refuses a response over the limit', async () => {
    const body = JSON.stringify('a'.repeat(9 * 1024 * 1024));
    const transport = createHttpTransport(
      'https://t',
      (async () =>
        new Response(body, { status: 200 })) as unknown as typeof fetch,
    );
    await expect(
      transport({ method: 'GET', path: '/x' }),
    ).rejects.toBeInstanceOf(TransportError);
  });

  it('classes a lost connection as a runner failure', () => {
    expect(classifyError(new TransportError('lost'))).toBe('runner');
  });
});

describe('state is never written through a planted link', () => {
  it('leaves the link target alone when a symlink sits at the temp name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'state-link-'));
    const victim = join(dir, 'victim.txt');
    writeFileSync(victim, 'keep');
    const path = join(dir, 'state.json');
    symlinkSync(victim, `${path}.tmp`);
    createFileStateStore(path).save({ runnerId: 'r1', token: 't', leases: {} });
    expect(readFileSync(victim, 'utf8')).toBe('keep');
    expect(createFileStateStore(path).load()?.runnerId).toBe('r1');
  });
});

describe('the command line', () => {
  const base = [
    '--state',
    '/tmp/s.json',
    '--version',
    '1.2.3',
    '--digest',
    `sha256:${'a'.repeat(64)}`,
  ];

  it('accepts https, and http only to loopback', () => {
    expect(
      parseCli(['run', '--url', 'https://tower.example', ...base]).url,
    ).toBe('https://tower.example');
    expect(
      parseCli(['run', '--url', 'http://127.0.0.1:3000', ...base]).url,
    ).toBe('http://127.0.0.1:3000');
  });

  it('refuses cleartext to a remote host, because the credential would cross it', () => {
    expect(() =>
      parseCli(['run', '--url', 'http://tower.example', ...base]),
    ).toThrow(UsageError);
  });

  it('refuses a state file inside the repository the engine runs in', () => {
    expect(() =>
      parseCli([
        'run',
        '--url',
        'https://t',
        '--state',
        '/repo/.tower/state.json',
        '--version',
        '1.2.3',
        '--digest',
        `sha256:${'a'.repeat(64)}`,
        '--repo',
        '/repo',
      ]),
    ).toThrow(UsageError);
  });

  it('refuses an empty value, on a flag that has no other check', () => {
    expect(() =>
      parseCli([
        'run',
        '--url',
        'https://tower.example',
        ...base,
        '--capability',
        '',
      ]),
    ).toThrow(/needs a value/);
  });

  it('refuses a state file inside the working directory when no --repo is given', () => {
    const inside = join(process.cwd(), 'state.json');
    expect(() =>
      parseCli([
        'run',
        '--url',
        'https://tower.example',
        '--state',
        inside,
        '--version',
        '1.2.3',
        '--digest',
        `sha256:${'a'.repeat(64)}`,
      ]),
    ).toThrow(UsageError);
  });

  it('does not mistake a directory named ..cache for a parent step', () => {
    const repo = join(process.cwd());
    expect(() =>
      parseCli([
        'run',
        '--url',
        'https://tower.example',
        '--state',
        join(repo, '..cache', 'state.json'),
        '--version',
        '1.2.3',
        '--digest',
        `sha256:${'a'.repeat(64)}`,
        '--repo',
        repo,
      ]),
    ).toThrow(UsageError);
  });
});

describe('the response limit admits a normal answer', () => {
  it('reads a body just under the limit', async () => {
    const body = JSON.stringify('a'.repeat(7 * 1024 * 1024));
    const transport = createHttpTransport(
      'https://t',
      (async () =>
        new Response(body, { status: 200 })) as unknown as typeof fetch,
    );
    const answer = await transport({ method: 'GET', path: '/x' });
    expect(answer.status).toBe(200);
    expect(typeof answer.body).toBe('string');
    expect((answer.body as string).length).toBe(7 * 1024 * 1024);
  });
});

describe('a body cut off mid-read is a lost connection', () => {
  it('reports it as a TransportError, so callers resend', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('"partial'));
        controller.error(new Error('connection reset'));
      },
    });
    const transport = createHttpTransport(
      'https://t',
      (async () =>
        new Response(stream, { status: 200 })) as unknown as typeof fetch,
    );
    await expect(
      transport({ method: 'GET', path: '/x' }),
    ).rejects.toBeInstanceOf(TransportError);
  });
});

describe('a cancelled run ends before its scope is granted again', () => {
  it('never has two runs at once on the same scope', async () => {
    const h = createFleetHarness();
    const cancelled = h.mission([{ title: 'A', scope: ['repo:a'] }]);
    const fake = new FakeOfficeEngine(new FakeWorld(), {
      steps: 2,
      stallAfterMutation: { step: 1, abortGraceMs: 150 },
    });
    const runner = await enroll(
      h,
      createMemoryStateStore(),
      officeRunnerEngine(fake),
    );
    await runner.pollOnce();
    await fake.stallReached;
    h.core.missions.cancelMission(
      h.ctx(),
      cancelled.id,
      h.getMission(cancelled.id).version,
      'stop',
    );
    // A second mission wants the same scope. The cancel frees it within the same claim.
    const next = h.mission([{ title: 'B', scope: ['repo:a'] }]);
    await runner.pollOnce();
    await runner.drain();
    expect(fake.maxActive).toBe(1);
    expect(h.getMission(next.id).packets[0]?.status).toBe('reported');
  });
});

describe('the state path is checked by identity, through links and missing folders', () => {
  const key = `sha256:${'a'.repeat(64)}`;
  function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'containment-'));
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    const link = join(dir, 'link');
    symlinkSync(repo, link);
    return { dir, repo, link };
  }
  const args = (state: string, repo: string) => [
    'run',
    '--url',
    'https://tower.example',
    '--state',
    state,
    '--version',
    '1.2.3',
    '--digest',
    key,
    '--repo',
    repo,
  ];

  it('refuses a state file under the repository reached through a symlink', () => {
    const { repo, link } = fixture();
    expect(() => parseCli(args(join(link, 'state.json'), repo))).toThrow(
      /outside/,
    );
  });

  it('refuses a state file in a folder that does not exist yet, under a symlink to the repository', () => {
    const { repo, link } = fixture();
    expect(() =>
      parseCli(args(join(link, 'new', 'deeper', 'state.json'), repo)),
    ).toThrow(/outside/);
  });

  it('accepts a state file outside the repository, including a parent step out of it', () => {
    const { repo } = fixture();
    expect(parseCli(args(join(repo, '..', 'state.json'), repo)).statePath).toBe(
      join(repo, '..', 'state.json'),
    );
  });

  it('keeps a folder named ..cache inside the repository', () => {
    const { repo } = fixture();
    expect(() =>
      parseCli(args(join(repo, '..cache', 'state.json'), repo)),
    ).toThrow(/outside/);
  });
});

describe('each request is bounded in time, and the size limit is exact', () => {
  it('passes an abort signal to fetch on every request', async () => {
    let signal: AbortSignal | null | undefined;
    const transport = createHttpTransport('https://t', (async (
      _url: string,
      init?: RequestInit,
    ) => {
      signal = init?.signal;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch);
    await transport({ method: 'GET', path: '/x' });
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('accepts a body of exactly the limit, and refuses one byte more', async () => {
    const limit = 8 * 1024 * 1024;
    // A JSON string of n characters is n + 2 bytes, since the quotes are added.
    const bodyOf = (bytes: number) => JSON.stringify('a'.repeat(bytes - 2));
    const fetchReturning = (text: string) =>
      (async () =>
        new Response(text, { status: 200 })) as unknown as typeof fetch;
    const answer = await createHttpTransport(
      'https://t',
      fetchReturning(bodyOf(limit)),
    )({
      method: 'GET',
      path: '/x',
    });
    expect(answer.status).toBe(200);
    await expect(
      createHttpTransport(
        'https://t',
        fetchReturning(bodyOf(limit + 1)),
      )({ method: 'GET', path: '/x' }),
    ).rejects.toBeInstanceOf(TransportError);
  });
});
