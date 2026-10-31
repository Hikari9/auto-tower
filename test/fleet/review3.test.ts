import { describe, expect, it } from 'vitest';
import { redactString } from '../../src/fleet/redact.js';
import { requirementsOf } from '../../src/fleet/scope.js';
import { TEST_WORKSPACE } from '../helpers/tower.js';
import {
  createFleetHarness,
  evidence,
  type FleetHarness,
  type RunnerClient,
} from './helpers.js';

const TTL = 60_000;
const GRACE = 120_000;
const SHA = 'a'.repeat(40);

async function hold(
  h: FleetHarness,
  runner: RunnerClient,
  scope = ['repo:app'],
) {
  const { id } = h.mission([{ scope }]);
  const a = (await runner.claim()).body.assignments.find(
    (x: { missionId: string }) => x.missionId === id,
  );
  if (a === undefined) {
    throw new Error('nothing claimed');
  }
  return {
    leaseId: a.leaseId as string,
    attemptId: a.attemptId as string,
    fence: a.fence as number,
    missionId: id,
  };
}

function lease(h: FleetHarness, id: string) {
  // biome-ignore lint/suspicious/noExplicitAny: raw row
  return h.db.get<any>('SELECT * FROM runner_leases WHERE id = ?', [id]);
}

describe('a runner that may not have the work gets no fence for it', () => {
  it('leaves the lease recovering, and lets it move to an eligible runner', async () => {
    const h = createFleetHarness();
    const a = await h.runner({ name: 'a', allowedScopes: ['repo:*'] });
    const b = await h.runner({ name: 'b' });
    const held = await hold(h, a);
    await a.checkpoint(held.leaseId, {
      fence: 1,
      ref: 'refs/heads/t',
      commit: SHA,
    });
    await h.call(h.owner.token, 'PATCH', `/runners/${a.id}`, {
      allowedScopes: ['repo:other'],
    });

    // Cycle after cycle, a reconciles and is told no. Its fence never changes and it never holds the lease.
    for (let i = 0; i < 3; i += 1) {
      h.clock.advance(TTL + 1_000);
      const poll = await a.claim();
      expect(poll.body.reconcile).toHaveLength(1);
      const back = await a.reconcile(held.leaseId, 1);
      expect(back.status).toBe(200);
      expect(back.body.assignment).toBeNull();
      expect(back.body.withheld).toBe('scope repo:app is not allowed');
      expect(back.body.lease.status).toBe('recovering');
      expect(back.body.lease.fence).toBe(1);
    }
    expect(lease(h, held.leaseId)).toMatchObject({
      status: 'recovering',
      fence: 1,
      runner_id: a.id,
    });
    // Nothing it has can renew or write.
    expect(
      (await a.progress(held.leaseId, { fence: 1, seq: 1, message: 'x' }))
        .status,
    ).toBe(409);
    expect(
      (await a.progress(held.leaseId, { fence: 2, seq: 1, message: 'x' }))
        .status,
    ).toBe(409);
    const hb = await a.heartbeat([evidence({ ...held, fence: 2 })]);
    expect(hb.body.leases).toEqual([]);
    expect(
      h.fleet
        .audit(TEST_WORKSPACE, { afterSeq: 0, limit: 500 })
        .filter((r) => r.kind === 'reconcile.withheld'),
    ).toHaveLength(3);

    // The grace period is not reset by those attempts, so b takes the work.
    h.clock.advance(GRACE);
    const moved = await b.claim();
    expect(moved.body.assignments).toHaveLength(1);
    expect(moved.body.assignments[0].resume.checkpoint.ref).toBe(
      'refs/heads/t',
    );
  });

  it('does the same for a runner whose mission is paused', async () => {
    const h = createFleetHarness();
    const a = await h.runner();
    const held = await hold(h, a);
    h.clock.advance(TTL + 1_000);
    await a.claim();
    const m = h.getMission(held.missionId);
    h.core.missions.transitionMission(
      h.ctx(),
      m.id,
      m.version,
      'needs-attention',
      'blocked',
    );
    const back = await a.reconcile(held.leaseId, 1);
    expect(back.body.withheld).toBe('mission is needs-attention');
    expect(lease(h, held.leaseId)).toMatchObject({
      status: 'recovering',
      fence: 1,
    });
  });
});

describe('redaction of what real secrets look like', () => {
  it('takes an unquoted value whole, whatever characters it holds', () => {
    const cases: Array<[string, string]> = [
      ['DB_PASSWORD=Corp\\svc-pw-123', 'svc-pw-123'],
      ['password=ab\\cdefgh', 'cdefgh'],
      ['password=abc,defgh', 'defgh'],
      ['token=abc;defgh', 'defgh'],
      ["'password' => 'hunter2secret'", 'hunter2secret'],
      ['"password" => "hunter2secret"', 'hunter2secret'],
      ['redis://:hunter2secret@host:6379', 'hunter2secret'],
      ['postgres://u:p@ssword-x@host/db', 'ssword-x'],
      ['--password hunter2secret', 'hunter2secret'],
      ['--password=hunter2secret', 'hunter2secret'],
      ['--token "hunter 2 secret"', 'secret'],
      ['curl -u admin:hunter2secret https://x', 'hunter2secret'],
      ['curl --user admin:hunter2secret https://x', 'hunter2secret'],
      ['Set-Cookie: session=hunter2secretvalue; Path=/', 'hunter2secretvalue'],
      ['Cookie: a=1; sid=hunter2secretvalue', 'hunter2secretvalue'],
      ['Proxy: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA'],
    ];
    for (const [input, needle] of cases) {
      expect(redactString(input), input).not.toContain(needle);
    }
  });

  it('keeps ordinary prose that mentions basic things', () => {
    for (const text of [
      'Basic setup/teardown steps',
      'basic src/fleet/leases.ts failed',
      'Basic authentication2 broke',
      'see basic python3/pip',
      'the password policy was reviewed',
      'he took a --pretty flag',
    ]) {
      expect(redactString(text), text).toBe(text);
    }
  });

  it('still stops at the end of an escaped JSON string', () => {
    expect(redactString('{\\"token\\":\\"abc123\\"}').includes('abc123')).toBe(
      false,
    );
  });
});

describe('scope names', () => {
  const key = (scope: string[]) =>
    requirementsOf('m', { id: 'p', scope }).scopeKey;
  const invalid = (scope: string[]) =>
    requirementsOf('m', { id: 'p', scope }).invalid;

  it('accepts real repository names that start with a dot, underscore or dash', () => {
    for (const name of [
      'org/.github',
      'org/_template',
      'a/-b',
      '.dotfiles',
      'a.b.c',
      'a/b.c/d',
    ]) {
      expect(invalid([`repo:${name}`]), name).toBeUndefined();
    }
    expect(key(['repo:Org/.GitHub'])).toBe(key(['repo:org/.github']));
  });

  it('refuses a name that ends in a dot, which some filesystems read as the name without it', () => {
    for (const name of ['foo.', 'foo..', 'a/b.', 'a./b']) {
      expect(invalid([`repo:${name}`]), name).toBeDefined();
    }
  });

  it('reads an entry with leading space or space before the colon as the same entry', () => {
    for (const alias of [
      ' repo:foo',
      'repo :foo',
      '\trepo: foo',
      ' REPO : Foo',
    ]) {
      expect(key([alias]), alias).toBe(key(['repo:foo']));
    }
    expect(
      requirementsOf('m', { id: 'p', scope: [' cap:docker'] }).capabilities,
    ).toEqual(['docker']);
    expect(key(['repo:foo', ' worktree :X'])).toBe(
      key(['repo:foo', 'worktree:x']),
    );
  });

  it('keeps a whitespace-prefixed alias exclusive when dispatched', async () => {
    const h = createFleetHarness();
    const a = await h.runner({ name: 'a' });
    const b = await h.runner({ name: 'b' });
    await a.claim();
    await b.claim();
    h.mission([{ scope: ['repo:foo'] }, { scope: [' repo:foo'] }]);
    h.tick();
    const [ra, rb] = await Promise.all([a.claim(), b.claim()]);
    expect([...ra.body.assignments, ...rb.body.assignments]).toHaveLength(1);
  });
});
