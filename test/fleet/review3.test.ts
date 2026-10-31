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
    expect(invalid(['repo:Org/.GitHub'])).toMatch(/write repo:org\/\.github$/);
  });

  it('refuses a name that ends in a dot, which some filesystems read as the name without it', () => {
    for (const name of ['foo.', 'foo..', 'a/b.', 'a./b']) {
      expect(invalid([`repo:${name}`]), name).toBeDefined();
    }
  });

  it('refuses an entry with leading space or space before the colon, but still reads it as a repo entry', () => {
    for (const alias of [
      ' repo:foo',
      'repo :foo',
      '\trepo: foo',
      ' REPO : Foo',
    ]) {
      expect(invalid([alias]), alias).toMatch(/write repo:foo$/);
    }
    expect(
      requirementsOf('m', { id: 'p', scope: [' cap:docker'] }).capabilities,
    ).toEqual(['docker']);
    expect(invalid(['repo:foo', ' worktree :X'])).toMatch(/write worktree:x$/);
  });

  it('never dispatches a whitespace-prefixed alias, so it cannot run beside the canonical repo', async () => {
    const h = createFleetHarness();
    const a = await h.runner({ name: 'a' });
    const b = await h.runner({ name: 'b' });
    await a.claim();
    await b.claim();
    h.mission([{ scope: ['repo:foo'] }, { scope: [' repo:foo'] }]);
    h.tick();
    const [ra, rb] = await Promise.all([a.claim(), b.claim()]);
    const got = [...ra.body.assignments, ...rb.body.assignments];
    expect(got).toHaveLength(1);
    expect(got[0].packet.scope).toEqual(['repo:foo']);
  });
});

describe('reconcile of withheld work, in detail', () => {
  async function narrowed() {
    const h = createFleetHarness();
    const a = await h.runner({ name: 'a', allowedScopes: ['repo:*'] });
    const held = await hold(h, a);
    h.clock.advance(TTL + 1_000);
    await a.claim();
    return { h, a, held };
  }

  it('turns a stale fence away with lease_fenced even when the work would be withheld', async () => {
    const { h, a, held } = await narrowed();
    await h.call(h.owner.token, 'PATCH', `/runners/${a.id}`, {
      allowedScopes: ['repo:other'],
    });
    const res = await a.reconcile(held.leaseId, 99);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('lease_fenced');
    expect(
      h.fleet
        .audit(TEST_WORKSPACE, { afterSeq: 0, limit: 500 })
        .filter((r) => r.kind === 'reconcile.withheld'),
    ).toHaveLength(0);
  });

  it('does not answer a reconcile of a lease that is not in recovery just because the work is withheld', async () => {
    const h = createFleetHarness();
    const a = await h.runner();
    const held = await hold(h, a);
    await h.call(h.owner.token, 'PATCH', `/runners/${a.id}`, { paused: true });
    const res = await a.reconcile(held.leaseId, 1);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('lease_fenced');
    expect(
      h.fleet
        .audit(TEST_WORKSPACE, { afterSeq: 0, limit: 500 })
        .filter((r) => r.kind === 'reconcile.withheld'),
    ).toHaveLength(0);
  });

  it('does not hand the work back on a lost-answer retry once the runner was narrowed or paused', async () => {
    const { h, a, held } = await narrowed();
    await a.reconcile(held.leaseId, 1); // the answer is lost
    expect(lease(h, held.leaseId)).toMatchObject({ status: 'held', fence: 2 });
    await h.call(h.owner.token, 'PATCH', `/runners/${a.id}`, { paused: true });
    const retry = await a.reconcile(held.leaseId, 1);
    expect(retry.status).toBe(200);
    expect(retry.body.assignment).toBeNull();
    expect(retry.body.withheld).toBe('runner is paused');
    expect(retry.body.lease).toMatchObject({ status: 'held', fence: 2 });
    await h.call(h.owner.token, 'PATCH', `/runners/${a.id}`, {
      paused: false,
      allowedScopes: ['repo:other'],
    });
    expect((await a.reconcile(held.leaseId, 1)).body.assignment).toBeNull();
  });

  it('records what was withheld, from whom, and when', async () => {
    const { h, a, held } = await narrowed();
    await h.call(h.owner.token, 'PATCH', `/runners/${a.id}`, {
      allowedScopes: ['repo:other'],
    });
    h.clock.advance(7_000);
    await a.reconcile(held.leaseId, 1);
    const [row] = h.fleet
      .audit(TEST_WORKSPACE, { afterSeq: 0, limit: 500 })
      .filter((r) => r.kind === 'reconcile.withheld');
    expect(row).toMatchObject({
      runnerId: a.id,
      leaseId: held.leaseId,
      at: h.clock.now().toISOString(),
      detail: { reason: 'scope repo:app is not allowed', presentedFence: 1 },
    });
  });

  it('reports a paused runner first, and tells it to pause', async () => {
    const { h, a, held } = await narrowed();
    await h.call(h.owner.token, 'PATCH', `/runners/${a.id}`, { paused: true });
    const m = h.getMission(held.missionId);
    h.core.missions.transitionMission(
      h.ctx(),
      m.id,
      m.version,
      'needs-attention',
      'blocked',
    );
    const res = await a.reconcile(held.leaseId, 1);
    expect(res.body.withheld).toBe('runner is paused');
    expect(res.body.lease.directives.pause).toBe(true);
  });
});

describe('a pause remembered through quarantine', () => {
  it('survives an unrelated PATCH of a quarantined runner, and is not logged for a runner that is not quarantined', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    await h.call(h.owner.token, 'PATCH', `/runners/${runner.id}`, {
      paused: true,
    });
    await h.call(h.owner.token, 'POST', `/runners/${runner.id}/quarantine`, {});
    await h.call(h.owner.token, 'PATCH', `/runners/${runner.id}`, {
      allowedScopes: ['repo:x'],
      maxConcurrent: 1,
    });
    expect(
      (
        await h.call(
          h.owner.token,
          'POST',
          `/runners/${runner.id}/unquarantine`,
        )
      ).body.runner.status,
    ).toBe('paused');

    const plain = h.fleet
      .audit(TEST_WORKSPACE, { afterSeq: 0, limit: 500 })
      .filter((r) => r.kind === 'runner.updated');
    expect(plain[0]?.detail).not.toHaveProperty('to.restoreTo');
    expect(plain[1]?.detail).toHaveProperty('to.restoreTo', 'paused');
  });
});

describe('redaction, every alternative', () => {
  it('redacts unterminated single quotes, every flag, and the shapes at the start of a string', () => {
    const cases: Array<[string, string]> = [
      ["secret='never closed hunter2", 'hunter2'],
      ...[
        'password',
        'passwd',
        'pass',
        'token',
        'secret',
        'api-key',
        'apikey',
        'auth-token',
        'access-token',
        'private-key',
        'credentials',
        'credential',
      ].map((flag): [string, string] => [
        `run --${flag} hunter2secret now`,
        'hunter2secret',
      ]),
      ['run --PASSWORD hunter2secret', 'hunter2secret'],
      ["--token 'hunter 2 secret'", 'secret'],
      ['-u admin:hunter2secret x', 'hunter2secret'],
      ['curl --user=admin:hunter2secret x', 'hunter2secret'],
      ['POSTGRES://bob:hunter2secret@host/db', 'hunter2secret'],
      ['secret.access.key=abc123xyz', 'abc123xyz'],
      ['client-secret-key=abc123xyz', 'abc123xyz'],
      ['token_for_the_production_service_x=abc123xyz', 'abc123xyz'],
      ['PASS: hunter2', 'hunter2'],
    ];
    for (const [input, needle] of cases) {
      expect(redactString(input), input).not.toContain(needle);
    }
  });

  it('keeps the text around a redacted value', () => {
    expect(redactString('password=hunter2 then keep')).toBe(
      '[REDACTED] then keep',
    );
    expect(redactString("secret='abc def' keep this text")).toBe(
      '[REDACTED] keep this text',
    );
    expect(redactString('secret="abc def" keep this text')).toBe(
      '[REDACTED] keep this text',
    );
    expect(redactString('bypass: ok and compass=north')).toBe(
      'bypass: ok and compass=north',
    );
  });

  it('redacts values under secret-named keys, key names that are secrets, and deep structures', async () => {
    const { redactValue } = await import('../../src/fleet/redact.js');
    const token = `ghp_${'Aa1Bb2Cc3Dd4Ee5Ff6Gg7'}${'Hh8Ii9'}`;
    const out = JSON.stringify(
      redactValue({
        pass: 'hunter2',
        cookie: 'sid=abc',
        [token]: 1,
        keep: 'plain',
      }),
    );
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('sid=abc');
    expect(out).not.toContain(token);
    expect(out).toContain('plain');
    const nested = (levels: number) => {
      let value: unknown = 'plain';
      for (let i = 0; i < levels; i += 1) {
        value = { next: value };
      }
      return JSON.stringify(redactValue(value));
    };
    expect(nested(8)).toContain('plain');
    expect(nested(9)).not.toContain('plain');
    expect(nested(9)).toContain('[REDACTED]');
  });
});

describe('scope names, limits and exact reasons', () => {
  const req = (scope: string[]) => requirementsOf('m', { id: 'p', scope });
  const key = (scope: string[]) => req(scope).scopeKey;

  it('accepts 16 segments and 128 characters and refuses one more', () => {
    expect(
      req([`repo:${Array(16).fill('a').join('/')}`]).invalid,
    ).toBeUndefined();
    expect(
      req([`repo:${Array(17).fill('a').join('/')}`]).invalid,
    ).toBeDefined();
    expect(req([`repo:${'a'.repeat(128)}`]).invalid).toBeUndefined();
    expect(req([`repo:${'a'.repeat(129)}`]).invalid).toBeDefined();
  });

  it('treats a newline as part of the entry, not the end of it', () => {
    expect(req(['repo:foo\n']).invalid).toMatch(/write repo:foo$/);
    expect(req(['repo:foo\nbar']).invalid).toBeDefined();
    expect(req(['repo:foo\n/../x']).invalid).toBeDefined();
  });

  it('keeps distinct names distinct and normalises repeatably', () => {
    expect(key(['repo:org/.github'])).not.toBe(key(['repo:org/hub']));
    expect(req(['repo:a.git/b']).invalid).toBeUndefined();
    expect(key(['repo:a.git/b'])).not.toBe(key(['repo:a/b']));
    expect(req(['repo:foo//']).invalid).toMatch(/write repo:foo$/);
    expect(req(['repo:foo.git.git']).invalid).toMatch(/write repo:foo$/);
    for (const ok of ['repo:a1', 'repo:a-', 'repo:a_', 'repo:9']) {
      expect(req([ok]).invalid, ok).toBeUndefined();
    }
  });

  it('says why a scope cannot be keyed, and never gives it a shared key', () => {
    expect(req(['repo:a', 'repo:b']).invalid).toBe(
      'it names more than one repo',
    );
    expect(req(['repo:a', 'worktree:x', 'worktree:y']).invalid).toBe(
      'it names more than one worktree',
    );
    expect(req(['worktree:x']).invalid).toBe('it names a worktree but no repo');
    expect(req(['repo:a/../b']).invalid).toBe(
      'a repo or worktree name is not a plain name',
    );
    for (const scope of [
      ['repo:a', 'repo:b'],
      ['repo:a', 'worktree:x', 'worktree:y'],
      ['worktree:x'],
      ['repo:a/../b'],
    ]) {
      expect(key(scope), scope.join(',')).toMatch(/^packet:/);
    }
  });
});

describe('what a withheld runner is told', () => {
  it('quotes the entry it refused, and redacts and caps it', async () => {
    const { requirementsOf: req } = await import('../../src/fleet/scope.js');
    expect(req('m', { id: 'p', scope: [' repo:foo'] }).invalid).toBe(
      '" repo:foo" is not in canonical form, write repo:foo',
    );
    const token = `ghp_${'zz9yy8xx7ww6vv5uu4tt3'}${'ss2rr1'}`;
    const h = createFleetHarness();
    const runner = await h.runner({ allowedScopes: ['repo:*'] });
    h.mission([{ scope: [`repo:${token}`] }]);
    const held = (await runner.claim()).body.assignments[0];
    await h.call(h.owner.token, 'PATCH', `/runners/${runner.id}`, {
      allowedScopes: ['repo:other'],
    });
    h.clock.advance(TTL + 1_000);
    await runner.claim();
    const back = await runner.reconcile(held.leaseId, 1);
    // The refusal names the scope it was about, with anything credential-shaped removed.
    expect(back.body.withheld).toBe('scope repo:[REDACTED] is not allowed');
    expect(JSON.stringify(back.body.withheld)).not.toContain(token);
  });
});

describe('canonical form, in every order and on every path', () => {
  const req = (scope: string[]) => requirementsOf('m', { id: 'p', scope });

  it('keeps a refusal whatever order the entries come in', () => {
    for (const scope of [
      ['repo:Foo', 'repo:foo'],
      ['repo:foo', 'repo:Foo'],
      ['REPO:foo', 'repo:foo', 'worktree:x'],
      ['worktree:X', 'repo:foo', 'worktree:x'],
      ['repo:foo', 'worktree:x', 'worktree:X'],
    ]) {
      expect(req(scope).invalid, scope.join(',')).toBeDefined();
      expect(req(scope).scopeKey, scope.join(',')).toMatch(/^packet:/);
    }
  });

  it('says exactly which entry was refused and what to write', () => {
    expect(req(['repo:foo.git']).invalid).toBe(
      '"repo:foo.git" is not in canonical form, write repo:foo',
    );
    expect(req([' repo:foo ']).invalid).toBe(
      '" repo:foo " is not in canonical form, write repo:foo',
    );
    expect(req(['REPO:foo']).invalid).toBe(
      '"REPO:foo" is not in canonical form, write repo:foo',
    );
    // Two refused entries: the last one is reported.
    expect(req(['repo:Foo', 'worktree:X']).invalid).toBe(
      '"worktree:X" is not in canonical form, write worktree:x',
    );
  });

  it('dispatches nothing from a packet that mixes a spelling policy never saw with the canonical one', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    const { id } = h.mission([{ scope: [' repo:foo', 'repo:foo'] }]);
    h.tick();
    expect((await runner.claim()).body.assignments).toEqual([]);
    expect(h.getMission(id).attempts).toHaveLength(0);
    const aliasFirst = h.mission([
      { scope: [' repo:bar'] },
      { scope: ['repo:bar'] },
    ]);
    h.tick();
    const got = (await runner.claim()).body.assignments;
    expect(got).toHaveLength(1);
    expect(h.getMission(aliasFirst.id).attempts).toHaveLength(1);
    expect(h.getMission(aliasFirst.id).attempts[0]?.packetId).toBe(
      got[0].packetId,
    );
  });

  it('states the reason from the broker itself, for dispatch and for a claim', async () => {
    const { ineligibleReason } = await import('../../src/fleet/broker.js');
    const h = createFleetHarness();
    const runner = await h.runner();
    await runner.claim();
    const { getRunner } = await import('../../src/fleet/store.js');
    const row = getRunner(h.db, TEST_WORKSPACE, runner.id);
    if (row === undefined) {
      throw new Error('runner missing');
    }
    for (const options of [
      { requireLive: true, load: 'dispatched' as const },
      { requireLive: false, load: 'none' as const },
    ]) {
      expect(
        ineligibleReason(
          h.db,
          h.config,
          row,
          'm',
          { id: 'p', scope: ['repo:Foo'] },
          h.clock.now(),
          options,
        ),
      ).toBe(
        'execution scope is ambiguous: "repo:Foo" is not in canonical form, write repo:foo',
      );
    }
  });

  it('withholds work that was dispatched before the rule, on claim and on reconcile, with the reason', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    await runner.claim();
    const { id } = h.mission([{ scope: ['repo:foo'] }]);
    h.tick(); // dispatched, not yet claimed
    h.db.run(
      'UPDATE missions SET snapshot_json = replace(snapshot_json, \'"repo:foo"\', \'"repo:Foo"\')',
    );
    const offer = await runner.claim();
    expect(offer.body.assignments).toEqual([]);
    expect(offer.body.withheld[0].reason).toBe(
      'execution scope is ambiguous: "repo:Foo" is not in canonical form, write repo:foo',
    );
    expect(h.db.all('SELECT id FROM runner_leases')).toEqual([]);

    // The same for a lease that already exists and is reconciled.
    h.db.run(
      'UPDATE missions SET snapshot_json = replace(snapshot_json, \'"repo:Foo"\', \'"repo:foo"\')',
    );
    const held = (await runner.claim()).body.assignments[0];
    expect(held.missionId).toBe(id);
    h.clock.advance(TTL + 1_000);
    await runner.claim();
    h.db.run(
      'UPDATE missions SET snapshot_json = replace(snapshot_json, \'"repo:foo"\', \'"repo:Foo"\')',
    );
    const back = await runner.reconcile(held.leaseId, 1);
    expect(back.body.assignment).toBeNull();
    expect(back.body.withheld).toBe(
      'execution scope is ambiguous: "repo:Foo" is not in canonical form, write repo:foo',
    );
    expect(lease(h, held.leaseId)).toMatchObject({
      status: 'recovering',
      fence: 1,
    });
  });
});
