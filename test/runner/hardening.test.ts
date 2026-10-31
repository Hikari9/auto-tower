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

describe('a permanent receipt refusal does not block the poll', () => {
  it('parks the lease and still reaches the claim', async () => {
    const h = createFleetHarness();
    h.mission([{ title: 'A', scope: ['repo:a'] }]);
    const engine = officeRunnerEngine(
      new FakeOfficeEngine(new FakeWorld(), { steps: 1 }),
    );
    const claims: string[] = [];
    const transport = harnessTransport(h, (path) => {
      if (path.endsWith('/receipts')) {
        return {
          status: 400,
          body: { error: { code: 'invalid', message: 'refused' } },
        };
      }
      if (path === '/runners/claims') {
        claims.push(path);
      }
      return undefined;
    });
    const runner = await enroll(h, createMemoryStateStore(), engine, transport);
    await runner.pollOnce();
    await runner.drain();
    // The receipt is refused for good. The next poll parks the lease and still claims.
    await expect(runner.pollOnce()).resolves.toBeDefined();
    const before = claims.length;
    await expect(runner.pollOnce()).resolves.toBeDefined();
    expect(claims.length).toBeGreaterThan(before);
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

  it('refuses an empty value', () => {
    expect(() => parseCli(['run', '--url', '', ...base])).toThrow(UsageError);
  });
});
