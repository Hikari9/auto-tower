import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
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
  TowerRefusal,
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
    const store = createMemoryStateStore();
    const runner = await enroll(h, store, engine, refusals.transport);
    await runner.pollOnce();
    await runner.drain();
    const afterFirst = refusals.posts();
    const second = await runner.pollOnce();
    expect(second.receiptsSent).toEqual([]);
    expect(refusals.posts()).toBe(afterFirst + 1);
    // Parked: the next poll does not send the receipt again, and still reaches the claim.
    const third = await runner.pollOnce();
    expect(refusals.posts()).toBe(afterFirst + 1);
    expect(third.retryAfterMs).toBeGreaterThanOrEqual(0);
    expect(Object.keys(store.load()?.leases ?? {})).toHaveLength(1);
  });

  it('retries a transient server fault on the next poll, and records the receipt once it clears', async () => {
    const h = createFleetHarness();
    const mission = h.mission([{ title: 'A', scope: ['repo:a'] }]);
    const engine = officeRunnerEngine(
      new FakeOfficeEngine(new FakeWorld(), { steps: 1 }),
    );
    // The first two answers are 503s: the job's own send, then a poll's resend.
    const refusals = receiptRefusals(h, 503, 'unavailable', { count: 2 });
    const store = createMemoryStateStore();
    const runner = await enroll(h, store, engine, refusals.transport);
    await runner.pollOnce();
    await runner.drain();
    // The poll's resend meets the second 503. That is transient, so the poll fails and nothing is parked.
    await expect(runner.pollOnce()).rejects.toBeInstanceOf(TowerRefusal);
    // The next poll sends the same receipt, and Tower accepts it.
    const retried = await runner.pollOnce();
    expect(retried.receiptsSent).toHaveLength(1);
    expect(refusals.posts()).toBe(3);
    expect(h.getMission(mission.id).packets[0]?.status).toBe('reported');
  });
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

  it('drops the lease on lease_fenced and reports why', async () => {
    const h = createFleetHarness();
    h.mission([{ title: 'A', scope: ['repo:a'] }]);
    const fake = new FakeOfficeEngine(new FakeWorld(), { steps: 2 });
    const store = createMemoryStateStore();
    const runner = await enroll(
      h,
      store,
      officeRunnerEngine(fake),
      progressRefused(h, 409, 'lease_fenced'),
    );
    const poll = await runner.pollOnce();
    await runner.drain();
    expect(poll.started).toHaveLength(1);
    expect(store.load()?.leases).toEqual({});
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

describe('a fatal refusal stops the running job before the process exits', () => {
  it('aborts and drains the engine when the runner is quarantined', async () => {
    const h = createFleetHarness();
    h.mission([{ title: 'A', scope: ['repo:a'] }]);
    const fake = new FakeOfficeEngine(new FakeWorld(), {
      steps: 2,
      stallAfterMutation: { step: 1 },
    });
    const runner = await enroll(
      h,
      createMemoryStateStore(),
      officeRunnerEngine(fake),
    );
    await runner.pollOnce();
    await fake.stallReached;
    const quarantined = await h.call(
      h.owner.token,
      'POST',
      `/runners/${runner.runnerId}/quarantine`,
      { reason: 'test' },
    );
    expect(quarantined.status).toBe(200);
    await expect(
      runner.run(new AbortController().signal),
    ).rejects.toMatchObject({
      code: 'runner_quarantined',
    });
    await runner.drain();
    expect(fake.aborted).toBe(true);
  });
});

describe('a stopping runner starts no job', () => {
  it('does not run an assignment that arrives after stop()', async () => {
    const h = createFleetHarness();
    h.mission([{ title: 'A', scope: ['repo:a'] }]);
    const fake = new FakeOfficeEngine(new FakeWorld(), { steps: 1 });
    const runner = await enroll(
      h,
      createMemoryStateStore(),
      officeRunnerEngine(fake),
    );
    runner.stop();
    await runner.pollOnce();
    await runner.drain();
    expect(fake.runs).toHaveLength(0);
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
