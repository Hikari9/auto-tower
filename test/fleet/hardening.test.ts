import { describe, expect, it } from 'vitest';
import { redactString } from '../../src/fleet/redact.js';
import { requirementsOf, scopeAllowed } from '../../src/fleet/scope.js';
import { TEST_WORKSPACE } from '../helpers/tower.js';
import {
  auditKinds,
  createFleetHarness,
  DIGEST,
  evidence,
  type FleetHarness,
  OTHER_DIGEST,
  OTHER_VERSION,
  type RunnerClient,
  VERSION,
} from './helpers.js';

const TTL = 60_000;
const GRACE = 120_000;
const SHA = 'd'.repeat(40);
const BIND = { version: VERSION, buildDigest: DIGEST, capabilities: [] };

interface Held {
  leaseId: string;
  attemptId: string;
  fence: number;
  missionId: string;
  packetId: string;
}

async function hold(
  h: FleetHarness,
  runner: RunnerClient,
  scope: string[] = ['repo:app'],
): Promise<Held> {
  const { id } = h.mission([{ scope }]);
  const a = (await runner.claim()).body.assignments.find(
    (x: { missionId: string }) => x.missionId === id,
  );
  if (a === undefined) {
    throw new Error('nothing claimed');
  }
  return {
    leaseId: a.leaseId,
    attemptId: a.attemptId,
    fence: a.fence,
    missionId: id,
    packetId: a.packetId,
  };
}

function lease(h: FleetHarness, id: string) {
  // biome-ignore lint/suspicious/noExplicitAny: raw row
  return h.db.get<any>('SELECT * FROM runner_leases WHERE id = ?', [id]);
}

function audit(h: FleetHarness, kind: string) {
  return h.fleet
    .audit(TEST_WORKSPACE, { afterSeq: 0, limit: 500 })
    .filter((r) => r.kind === kind);
}

/** The lower and higher runner id, since the broker breaks ties on id. */
async function pair(h: FleetHarness) {
  const a = await h.runner({ name: 'a', maxConcurrent: 3 });
  const b = await h.runner({ name: 'b', maxConcurrent: 3 });
  return a.id < b.id ? { lo: a, hi: b } : { lo: b, hi: a };
}

describe('redaction is linear and covers the gaps the review found', () => {
  const FAST_MS = 400;

  it('cannot be frozen by a long repeated word', () => {
    const inputs = [
      'secret.'.repeat(2_400),
      'token '.repeat(2_700),
      'password '.repeat(1_800),
      'a.'.repeat(8_000),
      'a-b.'.repeat(4_000),
      `${'"'.repeat(16_000)}`,
      `password=${'x'.repeat(16_000)}`,
      `-----BEGIN ${'PRIVATE KEY'}-----${'A'.repeat(16_000)}`,
      'http://'.repeat(2_000),
      'Bearer '.repeat(2_000),
    ];
    for (const input of inputs) {
      const started = performance.now();
      redactString(input);
      expect(performance.now() - started, input.slice(0, 20)).toBeLessThan(
        FAST_MS,
      );
    }
  });

  it('bounds what it scans', () => {
    const out = redactString('x'.repeat(500_000));
    expect(out.length).toBeLessThan(110_000);
    expect(out.endsWith('[TRUNCATED]')).toBe(true);
  });

  it('removes PGP armour, quoted values with spaces, webhooks, pass= and Authorization values', () => {
    const cases: Array<[string, string]> = [
      [
        `-----BEGIN ${'PGP PRIVATE KEY BLOCK'}-----\nlQOYBF\n-----END ${'PGP PRIVATE KEY BLOCK'}-----`,
        'lQOYBF',
      ],
      ['password: "correct horse battery staple"', 'horse'],
      ['{"password":"my secret phrase"}', 'phrase'],
      ["token = 'two words here'", 'words'],
      [
        `curl https://hooks.slack.com/services/${'T01234567/B01234567/abcdEFGHijkl'}`,
        'abcdEFGHijkl',
      ],
      [
        `https://discord.com/api/webhooks/${'123456789/abcDEFghiJKL_mno'}`,
        'abcDEFghiJKL_mno',
      ],
      ['pass=hunter2hunter2', 'hunter2hunter2'],
      ['Authorization: Basic YTpiY2RlZmdoaWo=', 'YTpiY2RlZmdoaWo'],
      ['GET /x?X-Amz-Signature=deadbeef01234567&a=1', 'deadbeef01234567'],
      ['GET /x?sig=abcdef0123456789', 'abcdef0123456789'],
    ];
    for (const [input, needle] of cases) {
      expect(redactString(input), input).not.toContain(needle);
    }
  });

  it('leaves ordinary words alone', () => {
    for (const text of [
      '12 tests passed: all green',
      'the author wrote a bypass',
      'pass the salt',
      'signature of the function is unchanged',
    ]) {
      expect(redactString(text), text).toBe(text);
    }
  });
});

describe('the audit never stores a runner-supplied secret', () => {
  const TOKEN = `ghp_${'Zz9Yy8Xx7Ww6Vv5Uu4Tt3'}${'Ss2Rr1'}`;

  it('redacts a secret used as a lease id, in the column and in the API', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    await runner.heartbeat([
      { leaseId: TOKEN, attemptId: 'att_x', fence: 1, progressSeq: 0 },
    ]);
    await runner.progress(TOKEN, { fence: 1, seq: 1, message: 'x' });
    await runner.receipt(TOKEN, {
      receiptId: 'r',
      fence: 1,
      outcome: 'failed',
    });
    await runner.reconcile(TOKEN, 1);
    await runner.call('POST', `/runners/leases/${'a'.repeat(3_000)}/progress`, {
      fence: 1,
      seq: 1,
    });

    const stored = JSON.stringify(h.db.all('SELECT * FROM fleet_audit'));
    expect(stored).not.toContain(TOKEN);
    const api = await h.call(h.owner.token, 'GET', '/runners/audit?limit=500');
    expect(JSON.stringify(api.body)).not.toContain(TOKEN);
    expect(audit(h, 'progress.rejected').length).toBeGreaterThan(0);
    for (const row of h.db.all<{ lease_id: string | null }>(
      'SELECT lease_id FROM fleet_audit',
    )) {
      expect((row.lease_id ?? '').length).toBeLessThanOrEqual(128);
    }
  });

  it('refuses a credential-shaped receipt id or checkpoint ref outright', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    const held = await hold(h, runner);
    const receipt = await runner.receipt(held.leaseId, {
      receiptId: TOKEN,
      fence: 1,
      outcome: 'succeeded',
    });
    expect(receipt.status).toBe(400);
    const ref = await runner.checkpoint(held.leaseId, {
      fence: 1,
      ref: `refs/heads/${TOKEN}`,
    });
    expect(ref.status).toBe(400);
    const done = await runner.receipt(held.leaseId, {
      receiptId: 'fine',
      fence: 1,
      outcome: 'succeeded',
    });
    expect(done.status).toBe(201);
    expect(lease(h, held.leaseId).close_reason).toBe('receipt fine: succeeded');
    expect(
      JSON.stringify(h.db.all('SELECT * FROM runner_leases')),
    ).not.toContain(TOKEN);
  });

  it('only accepts a ref that cannot be read as a git option or path trick', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    const held = await hold(h, runner);
    for (const ref of [
      '--all',
      '-f',
      '/abs',
      'a//b',
      'a/',
      'x.lock',
      '.',
      'a..b',
      'has space',
    ]) {
      const res = await runner.checkpoint(held.leaseId, { fence: 1, ref });
      expect(res.status, ref).toBe(400);
    }
    expect(
      (
        await runner.checkpoint(held.leaseId, {
          fence: 1,
          ref: 'refs/heads/tower/x-1.2',
          commit: SHA,
        })
      ).status,
    ).toBe(201);
  });
});

describe('one execution scope is one scope', () => {
  const p = (scope: string[]) => ({ id: 'p', scope });

  it('normalises names and refuses a scope that cannot be keyed', () => {
    const key = (scope: string[]) => requirementsOf('m', p(scope)).scopeKey;
    // A spelling policy never saw is refused, not folded into the canonical repository.
    for (const alias of ['repo:Foo', 'repo:foo/', 'repo:foo.git']) {
      expect(requirementsOf('m', p([alias])).invalid, alias).toMatch(
        /canonical form, write repo:foo$/,
      );
      expect(key([alias]), alias).toMatch(/^packet:/);
    }
    expect(key(['repo:a', 'worktree:b'])).not.toBe(key(['repo:a#worktree:b']));
    for (const scope of [
      ['repo:a', 'repo:b'],
      ['worktree:x'],
      ['repo:a', 'worktree:x', 'worktree:y'],
      ['repo:a#worktree:b'],
      ['repo:'],
    ]) {
      expect(
        requirementsOf('m', p(scope)).invalid,
        scope.join(','),
      ).toBeDefined();
    }
    expect(
      requirementsOf('m', p(['repo:a', 'worktree:x'])).invalid,
    ).toBeUndefined();
  });

  it('allows a prefix scope only for names under the prefix', () => {
    expect(scopeAllowed(['repo:*'], 'worktree:x')).toBe(false);
    expect(scopeAllowed(['repo:*'], 'repo')).toBe(false);
    expect(scopeAllowed(['repo:a*'], 'repo:b')).toBe(false);
    expect(scopeAllowed(['repo:a*'], 'repo:ab')).toBe(true);
  });

  it('never dispatches a packet that names two repos, so two runners cannot both mutate one', async () => {
    const h = createFleetHarness();
    const a = await h.runner({ name: 'a' });
    const b = await h.runner({ name: 'b' });
    const both = h.mission([{ scope: ['repo:a', 'repo:b'] }]);
    const res = await a.claim();
    expect(res.body.assignments).toEqual([]);
    expect(h.getMission(both.id).attempts).toHaveLength(0);
    expect((await b.claim()).body.assignments).toEqual([]);
  });

  it('dispatches the canonical spelling and never an alias of it', async () => {
    const h = createFleetHarness();
    const a = await h.runner({ name: 'a' });
    const b = await h.runner({ name: 'b' });
    await a.claim();
    await b.claim();
    h.mission([
      { scope: ['repo:Foo'] },
      { scope: ['repo:foo.git'] },
      { scope: ['repo:foo'] },
    ]);
    h.tick();
    const [ra, rb] = await Promise.all([a.claim(), b.claim()]);
    const got = [...ra.body.assignments, ...rb.body.assignments];
    expect(got).toHaveLength(1);
    expect(got[0].packet.scope).toEqual(['repo:foo']);
    expect([...ra.body.withheld, ...rb.body.withheld]).toEqual([]);
  });

  it('does not allow a runner allowed only repo:* to take another scope', async () => {
    const h = createFleetHarness();
    const runner = await h.runner({ allowedScopes: ['repo:*'] });
    const { id } = h.mission([{ scope: ['other:thing'] }]);
    expect((await runner.claim()).body.assignments).toEqual([]);
    expect(h.getMission(id).attempts).toHaveLength(0);
  });
});

describe('an assignment survives a lost response', () => {
  it('is sent again until the runner shows evidence for it', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    const { id } = h.mission([{ title: 'ship', instructions: 'ship it' }]);
    const first = (await runner.claim()).body.assignments[0];
    // The response never arrived. The runner polls again knowing nothing.
    const again = (await runner.claim()).body.assignments[0];
    expect(again.leaseId).toBe(first.leaseId);
    expect(again.packet.instructions).toBe('ship it');
    expect(h.db.all('SELECT id FROM runner_leases')).toHaveLength(1);
    expect(h.getMission(id).attempts).toHaveLength(1);
    expect(
      (await runner.claim({ active: [evidence(first)] })).body.assignments,
    ).toEqual([]);
  });

  it('is handed back with the work when a runner that lost its state reconciles', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    const { id } = h.mission([{ instructions: 'do the thing' }]);
    const first = (await runner.claim()).body.assignments[0];
    h.clock.advance(TTL + 1_000);
    await runner.claim();
    const back = await runner.reconcile(first.leaseId, 1);
    expect(back.status).toBe(200);
    expect(back.body.assignment).toMatchObject({
      missionId: id,
      packet: { instructions: 'do the thing' },
      fence: 2,
    });
    // The retried reconcile answers the same, with the work.
    const retry = await runner.reconcile(first.leaseId, 1);
    expect(retry.body.assignment.packet.instructions).toBe('do the thing');
  });

  it('retires the lost-answer retry once the runner shows it holds the new fence', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    const held = await hold(h, runner);
    h.clock.advance(TTL + 1_000);
    await runner.claim();
    await runner.reconcile(held.leaseId, 1);
    expect(
      (
        await runner.progress(held.leaseId, {
          fence: 2,
          seq: 1,
          message: 'back',
        })
      ).status,
    ).toBe(201);
    const zombie = await runner.reconcile(held.leaseId, 1);
    expect(zombie.status).toBe(409);
    expect(zombie.body.error.code).toBe('lease_fenced');
  });

  it('does not re-send work to a paused runner or one that lost eligibility', async () => {
    const h = createFleetHarness();
    const runner = await h.runner({ allowedScopes: ['repo:*'] });
    await hold(h, runner);
    await h.call(h.owner.token, 'PATCH', `/runners/${runner.id}`, {
      paused: true,
    });
    const paused = await runner.claim();
    expect(paused.body.assignments).toEqual([]);
    expect(paused.body.withheld[0].reason).toBe('runner is paused');
    await h.call(h.owner.token, 'PATCH', `/runners/${runner.id}`, {
      paused: false,
      allowedScopes: ['repo:other'],
    });
    expect((await runner.claim()).body.withheld[0].reason).toBe(
      'scope repo:app is not allowed',
    );
  });
});

describe('quarantine', () => {
  it('keeps a human pause through quarantine and unquarantine', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    await h.call(h.owner.token, 'PATCH', `/runners/${runner.id}`, {
      paused: true,
    });
    await h.call(h.owner.token, 'POST', `/runners/${runner.id}/quarantine`, {});
    // A second quarantine must not overwrite what is remembered.
    await h.call(h.owner.token, 'POST', `/runners/${runner.id}/quarantine`, {});
    const out = await h.call(
      h.owner.token,
      'POST',
      `/runners/${runner.id}/unquarantine`,
    );
    expect(out.body.runner.status).toBe('paused');
    expect(JSON.stringify(out.body)).not.toContain('priorStatus');
  });

  it('cannot be lifted by a pause toggle', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    await h.call(h.owner.token, 'POST', `/runners/${runner.id}/quarantine`, {});
    for (const paused of [false, true]) {
      const res = await h.call(
        h.owner.token,
        'PATCH',
        `/runners/${runner.id}`,
        { paused },
      );
      expect(res.body.runner.status).toBe('quarantined');
    }
    expect((await runner.claim()).body.error.code).toBe('runner_quarantined');
  });

  it('audits an unquarantine only when something changed', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    await h.call(h.owner.token, 'POST', `/runners/${runner.id}/unquarantine`);
    expect(audit(h, 'runner.unquarantined')).toHaveLength(0);
  });

  it('refuses old-fence writes to a lease in recovery even though its expiry has not passed', async () => {
    const h = createFleetHarness();
    const a = await h.runner();
    const held = await hold(h, a);
    await h.call(h.owner.token, 'POST', `/runners/${a.id}/quarantine`, {});
    await h.call(h.owner.token, 'POST', `/runners/${a.id}/unquarantine`);
    expect(Date.parse(lease(h, held.leaseId).expires_at)).toBeGreaterThan(
      h.clock.now().getTime(),
    );
    for (const res of [
      await a.progress(held.leaseId, { fence: 1, seq: 1, message: 'x' }),
      await a.checkpoint(held.leaseId, { fence: 1, ref: 'refs/heads/x' }),
      await a.receipt(held.leaseId, {
        receiptId: 'r',
        fence: 1,
        outcome: 'succeeded',
      }),
    ]) {
      expect(res.body.error.code).toBe('lease_expired');
    }
    expect(h.db.all('SELECT seq FROM runner_progress')).toHaveLength(0);
  });

  it('lets the original runner reconcile first after a long quarantine, and refuses stale writes meanwhile', async () => {
    const h = createFleetHarness();
    const a = await h.runner({ name: 'a' });
    const b = await h.runner({ name: 'b' });
    const held = await hold(h, a);
    await a.checkpoint(held.leaseId, {
      fence: 1,
      ref: 'refs/heads/t',
      commit: SHA,
    });
    await h.call(h.owner.token, 'POST', `/runners/${a.id}/quarantine`, {});
    h.clock.advance(60 * 60_000);
    await h.call(h.owner.token, 'POST', `/runners/${a.id}/unquarantine`);

    // The lease is recovering with an unexpired-looking record, so nothing old is accepted.
    for (const res of [
      await a.progress(held.leaseId, { fence: 1, seq: 1, message: 'x' }),
      await a.checkpoint(held.leaseId, { fence: 1, ref: 'refs/heads/u' }),
      await a.receipt(held.leaseId, {
        receiptId: 'r',
        fence: 1,
        outcome: 'succeeded',
      }),
    ]) {
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('lease_expired');
    }
    expect(lease(h, held.leaseId).status).toBe('recovering');

    // b polls straight away: the grace period restarted, so the work has not moved.
    expect((await b.claim()).body.assignments).toEqual([]);
    expect(lease(h, held.leaseId).runner_id).toBe(a.id);
    const poll = await a.claim();
    expect(poll.body.reconcile).toHaveLength(1);
    expect((await a.reconcile(held.leaseId, 1)).status).toBe(200);
  });
});

describe('an offer nobody will claim', () => {
  it('can be released by a human, which fails the attempt', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    await runner.claim();
    const { id } = h.mission([{ scope: ['repo:one'] }]);
    h.tick();
    const attempt = h.getMission(id).attempts[0];
    expect(attempt?.status).toBe('leased');
    await h.call(h.owner.token, 'POST', `/runners/${runner.id}/quarantine`, {});

    expect(
      (
        await runner.call(
          'POST',
          `/runners/attempts/${attempt?.id}/release`,
          {},
        )
      ).status,
    ).toBe(403);
    const res = await h.call(
      h.owner.token,
      'POST',
      `/runners/attempts/${attempt?.id}/release`,
      { reason: 'runner retired' },
    );
    expect(res.status).toBe(200);
    const state = h.getMission(id);
    expect(state.attempts[0]?.status).toBe('self-reported-failed');
    expect(state.packets[0]?.status).toBe('failed');
    expect(auditKinds(h)).toContain('offer.released');
    // It is gone: a second release, an unknown attempt and a leased one are all refused.
    expect(
      (
        await h.call(
          h.owner.token,
          'POST',
          `/runners/attempts/${attempt?.id}/release`,
          {},
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await h.call(
          h.owner.token,
          'POST',
          '/runners/attempts/att_none/release',
          {},
        )
      ).status,
    ).toBe(404);
  });

  it('is not released through this route once a lease exists', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    const held = await hold(h, runner);
    const res = await h.call(
      h.owner.token,
      'POST',
      `/runners/attempts/${held.attemptId}/release`,
      {},
    );
    expect(res.status).toBe(409);
    expect(lease(h, held.leaseId).status).toBe('held');
  });
});

describe('the broker ranks by affinity before load and id', () => {
  it('sends the next job on a scope to the runner that last held it, even when the other has the lower id', async () => {
    const h = createFleetHarness();
    const { lo, hi } = await pair(h);
    await h.call(h.owner.token, 'PATCH', `/runners/${lo.id}`, { paused: true });
    await lo.claim();
    h.mission([{ scope: ['repo:app'] }]);
    const first = (await hi.claim()).body.assignments[0];
    await hi.receipt(first.leaseId, {
      receiptId: 'r1',
      fence: first.fence,
      outcome: 'succeeded',
    });
    await h.call(h.owner.token, 'PATCH', `/runners/${lo.id}`, {
      paused: false,
    });

    h.mission([{ scope: ['repo:app'] }]);
    expect((await lo.claim()).body.assignments).toEqual([]);
    expect((await hi.claim()).body.assignments).toHaveLength(1);
  });

  it('prefers a runner that worked on the mission, and scope affinity beats mission affinity', async () => {
    const h = createFleetHarness();
    const { lo, hi } = await pair(h);
    await h.call(h.owner.token, 'PATCH', `/runners/${lo.id}`, { paused: true });
    await lo.claim();
    // hi works on mission M (repo:x), so it has mission affinity there.
    const m = h.mission([{ scope: ['repo:x'] }]);
    const first = (await hi.claim()).body.assignments[0];
    await hi.receipt(first.leaseId, {
      receiptId: 'r1',
      fence: first.fence,
      outcome: 'succeeded',
    });
    await h.call(h.owner.token, 'PATCH', `/runners/${lo.id}`, {
      paused: false,
    });
    const state = h.getMission(m.id);
    h.core.missions.addPacket(h.ctx(), m.id, state.version, {
      title: 'more',
      instructions: '',
      scope: ['repo:y'],
      required: true,
      dependsOn: [],
    });
    const added = h.getMission(m.id).packets.at(-1);
    h.core.missions.authorizePacket(
      h.ctx(),
      m.id,
      h.getMission(m.id).version,
      added?.id ?? '',
      [],
    );
    expect((await lo.claim()).body.assignments).toEqual([]);
    expect((await hi.claim()).body.assignments).toHaveLength(1);
  });
});

describe('every fenced write path checks the runner first', () => {
  it('refuses checkpoints and receipts from a runner whose bound version left the range', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    const held = await hold(h, runner);
    h.setRange({ min: '1.3.0', max: '1.9.9' });
    for (const res of [
      await runner.checkpoint(held.leaseId, { fence: 1, ref: 'refs/heads/x' }),
      await runner.receipt(held.leaseId, {
        receiptId: 'r',
        fence: 1,
        outcome: 'succeeded',
      }),
      await runner.progress(held.leaseId, { fence: 1, seq: 1, message: 'x' }),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('version_unsupported');
    }
    expect(audit(h, 'runner.rejected')).toHaveLength(3);
    expect(h.db.all('SELECT id FROM runner_checkpoints')).toHaveLength(0);
  });

  it('answers a quarantined runner with runner_quarantined on every write, not a lease error', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    const held = await hold(h, runner);
    await h.call(h.owner.token, 'POST', `/runners/${runner.id}/quarantine`, {});
    for (const res of [
      await runner.checkpoint(held.leaseId, { fence: 1, ref: 'refs/heads/x' }),
      await runner.receipt(held.leaseId, {
        receiptId: 'r',
        fence: 1,
        outcome: 'succeeded',
      }),
      await runner.reconcile(held.leaseId, 1),
    ]) {
      expect(res.body.error.code).toBe('runner_quarantined');
    }
  });

  it('checks the reported version and digest on heartbeat and reconcile', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    const held = await hold(h, runner);
    for (const wrong of [
      { version: OTHER_VERSION },
      { buildDigest: OTHER_DIGEST },
    ]) {
      const hb = await runner.heartbeat([], wrong);
      expect(hb.status).toBe(403);
      expect(hb.body.error.code).toBe('version_mismatch');
    }
    h.clock.advance(TTL + 1_000);
    await runner.claim();
    const res = await runner.call(
      'POST',
      `/runners/leases/${held.leaseId}/reconcile`,
      {
        version: OTHER_VERSION,
        buildDigest: DIGEST,
        fence: 1,
        progressSeq: 0,
      },
    );
    expect(res.status).toBe(403);
    expect(lease(h, held.leaseId).status).toBe('recovering');
  });

  it('records checkpoint and receipt refusals after a plain expiry', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    const held = await hold(h, runner);
    h.clock.advance(TTL + 1_000);
    expect(
      (await runner.checkpoint(held.leaseId, { fence: 1, ref: 'refs/heads/x' }))
        .body.error.code,
    ).toBe('lease_expired');
    expect(
      (
        await runner.receipt(held.leaseId, {
          receiptId: 'r',
          fence: 1,
          outcome: 'succeeded',
        })
      ).body.error.code,
    ).toBe('lease_expired');
    expect(audit(h, 'checkpoint.rejected')).toHaveLength(1);
    expect(audit(h, 'receipt.rejected')).toHaveLength(1);
  });

  it('refuses a reconcile with the wrong fence and lets the right one through', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    const held = await hold(h, runner);
    h.clock.advance(TTL + 1_000);
    await runner.claim();
    const wrong = await runner.reconcile(held.leaseId, 7);
    expect(wrong.status).toBe(409);
    expect(lease(h, held.leaseId)).toMatchObject({
      status: 'recovering',
      fence: 1,
    });
    expect(audit(h, 'reconcile.rejected')).toHaveLength(1);
    expect((await runner.reconcile(held.leaseId, 1)).status).toBe(200);
  });

  it('refuses a receipt id reused with another outcome or other evidence', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    const held = await hold(h, runner);
    const body = {
      receiptId: 'rc',
      fence: 1,
      outcome: 'succeeded',
      summary: 's',
      evidence: { a: 1 },
    };
    expect((await runner.receipt(held.leaseId, body)).status).toBe(201);
    for (const changed of [{ outcome: 'failed' }, { evidence: { a: 2 } }]) {
      const res = await runner.receipt(held.leaseId, { ...body, ...changed });
      expect(res.status, JSON.stringify(changed)).toBe(409);
      expect(res.body.error.code).toBe('receipt_conflict');
    }
    expect(
      h.db.all("SELECT seq FROM events WHERE type = 'attempt.reported'"),
    ).toHaveLength(1);
  });
});

describe('leases are only kept alive by evidence of work', () => {
  it('renews on valid progress and on a valid checkpoint', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    const held = await hold(h, runner);
    h.clock.advance(TTL * 0.8);
    const progress = await runner.progress(held.leaseId, {
      fence: 1,
      seq: 1,
      message: 'a',
    });
    expect(Date.parse(progress.body.expiresAt)).toBe(
      h.clock.now().getTime() + TTL,
    );
    h.clock.advance(TTL * 0.8);
    const checkpoint = await runner.checkpoint(held.leaseId, {
      fence: 1,
      ref: 'refs/heads/x',
    });
    expect(Date.parse(checkpoint.body.expiresAt)).toBe(
      h.clock.now().getTime() + TTL,
    );
    h.clock.advance(TTL * 0.8);
    h.fleet.sweep(TEST_WORKSPACE);
    expect(lease(h, held.leaseId).status).toBe('held');
  });

  it('never shortens a lease when the clock steps back', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    const held = await hold(h, runner);
    const before = lease(h, held.leaseId).expires_at;
    h.clock.advance(-30_000);
    await runner.heartbeat([evidence(held)]);
    expect(lease(h, held.leaseId).expires_at).toBe(before);
  });

  it('lists a lease in recovery under reconcile, not as unmatched, and does not renew it', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    const held = await hold(h, runner);
    h.clock.advance(TTL + 1_000);
    const before = lease(h, held.leaseId).expires_at;
    const res = await runner.heartbeat([evidence(held)]);
    expect(res.body.unmatched).toEqual([]);
    expect(res.body.leases).toEqual([]);
    expect(res.body.reconcile).toHaveLength(1);
    expect(lease(h, held.leaseId).expires_at).toBe(before);
  });

  it('closes a lease whose attempt was reported elsewhere, and frees the scope', async () => {
    const h = createFleetHarness();
    const a = await h.runner({ name: 'a' });
    const held = await hold(h, a);
    const mission = h.getMission(held.missionId);
    h.core.missions.reportAttempt(
      h.ctx(),
      mission.id,
      mission.version,
      held.attemptId,
      'succeeded',
      'by hand',
    );
    const hb = await a.heartbeat([evidence(held)]);
    expect(hb.body.unmatched[0].reason).toBe('lease is completed');
    expect(lease(h, held.leaseId).status).toBe('completed');
    h.mission([{ scope: ['repo:app'] }]);
    h.clock.advance(h.config.livenessWindowMs - 1_000);
    expect((await a.claim()).body.assignments).toHaveLength(1);
  });

  it('applies claim evidence once, so each unmatched item is audited once per poll', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    await runner.claim({
      active: [
        { leaseId: 'lse_x', attemptId: 'att_x', fence: 1, progressSeq: 0 },
      ],
    });
    expect(audit(h, 'heartbeat.unmatched')).toHaveLength(1);
  });
});

describe('reassignment', () => {
  async function stranded(h: FleetHarness) {
    const a = await h.runner({ name: 'a' });
    const held = await hold(h, a);
    await a.checkpoint(held.leaseId, {
      fence: 1,
      ref: 'refs/heads/t',
      commit: SHA,
    });
    return { a, held };
  }

  it('never picks the runner that is already holding the lease, even while it is live', async () => {
    const h = createFleetHarness();
    const { a, held } = await stranded(h);
    h.clock.advance(TTL + GRACE + 1_000);
    const bogus = evidence({ ...held, fence: 9 });
    const res = await a.claim({ active: [bogus] });
    expect(res.body.reconcile).toHaveLength(1);
    expect(res.body.assignments).toEqual([]);
    expect(lease(h, held.leaseId).status).toBe('recovering');
    expect(h.db.all('SELECT id FROM runner_leases')).toHaveLength(1);

    // Nobody else was eligible, so the retry backed off. Once it is over, b takes the work.
    const b = await h.runner({ name: 'b' });
    h.clock.advance(h.config.backoff.baseMs + 1);
    expect((await b.claim()).body.assignments).toHaveLength(1);
  });

  it('does not move work while its mission is paused', async () => {
    const h = createFleetHarness();
    const { held } = await stranded(h);
    const b = await h.runner({ name: 'b' });
    const m = h.getMission(held.missionId);
    h.core.missions.transitionMission(
      h.ctx(),
      m.id,
      m.version,
      'waiting-external',
      'blocked',
    );
    h.clock.advance(TTL + GRACE + 1_000);
    expect((await b.claim()).body.assignments).toEqual([]);
    expect(lease(h, held.leaseId).status).toBe('recovering');
  });

  it('does not move work while its runner is paused', async () => {
    const h = createFleetHarness();
    const { a, held } = await stranded(h);
    const b = await h.runner({ name: 'b' });
    await h.call(h.owner.token, 'PATCH', `/runners/${a.id}`, { paused: true });
    h.clock.advance(TTL + GRACE + 1_000);
    expect((await b.claim()).body.assignments).toEqual([]);
    expect(lease(h, held.leaseId).status).toBe('recovering');
  });
});

describe('enrollment details', () => {
  it('re-checks the supported range at registration, without using the token up', async () => {
    const h = createFleetHarness();
    const enrolled = await h.enroll();
    const token = enrolled.body.enrollment.token as string;
    h.setRange({ min: '1.3.0', max: '1.9.9' });
    const res = await h.call(token, 'POST', '/runners/register', BIND);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('version_unsupported');
    expect(h.db.all('SELECT id FROM runners')).toHaveLength(0);
    h.setRange({ min: '1.0.0', max: '1.9.9' });
    expect(
      (await h.call(token, 'POST', '/runners/register', BIND)).status,
    ).toBe(201);
  });

  it('caps the lifetime at the configured maximum and defaults to the configured default', async () => {
    const h = createFleetHarness({
      config: { enrollmentTtlMs: { default: 900_000, max: 3_600_000 } },
    });
    const now = h.clock.now().getTime();
    const capped = await h.enroll({ expiresInSeconds: 86_400 });
    expect(Date.parse(capped.body.enrollment.expiresAt) - now).toBe(3_600_000);
    const dflt = await h.enroll();
    expect(Date.parse(dflt.body.enrollment.expiresAt) - now).toBe(900_000);
  });
});

describe('who sees which lease', () => {
  it("answers a runner the same for another runner's lease as for one that does not exist", async () => {
    const h = createFleetHarness();
    const a = await h.runner({ name: 'a' });
    const b = await h.runner({ name: 'b' });
    const held = await hold(h, a);
    const theirs = await b.call('GET', `/runners/leases/${held.leaseId}`);
    const missing = await b.call('GET', '/runners/leases/lse_missing');
    expect(theirs.status).toBe(404);
    expect(theirs.body).toEqual(missing.body);
    expect(
      (await a.call('GET', `/runners/leases/${held.leaseId}`)).status,
    ).toBe(200);
  });
});
