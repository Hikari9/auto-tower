import { describe, expect, it } from 'vitest';
import { FleetError } from '../../src/fleet/errors.js';
import { redactString } from '../../src/fleet/redact.js';
import { requirementsOf } from '../../src/fleet/scope.js';
import { mission } from '../core/helpers.js';
import { seedPrincipal, TEST_WORKSPACE } from '../helpers/tower.js';
import {
  clientFor,
  createFleetHarness,
  DIGEST,
  evidence,
  type FleetHarness,
  type RunnerClient,
  VERSION,
} from './helpers.js';

const TTL = 60_000;
const GRACE = 120_000;
const SHA = 'e'.repeat(40);
const SHA2 = 'f'.repeat(40);

interface Held {
  leaseId: string;
  attemptId: string;
  fence: number;
  missionId: string;
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

describe('redaction of escaped, spaced and long values', () => {
  it('removes secrets the first pass left behind', () => {
    const cases: Array<[string, string]> = [
      ['password=\\"hunter2xyz\\"', 'hunter2xyz'],
      ['{\\"password\\":\\"hunter2xyz\\"}', 'hunter2xyz'],
      ['PASSWORD = "a\\"b hunter2"', 'hunter2'],
      ['token      =abc123xyz', 'abc123xyz'],
      ['bearer:abcdefghijklmnop', 'abcdefghijklmnop'],
      ['Proxy: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA'],
      ['secret="a\nb-second-line"', 'b-second-line'],
      [`secret="${'A'.repeat(3_000)}"`, 'AAAAAAAAAA'],
      [`secret='${'B'.repeat(3_000)}'`, 'BBBBBBBBBB'],
      [`secret=${'C'.repeat(3_000)}`, 'CCCCCCCCCC'],
      [`Authorization: "${'D'.repeat(3_000)}"`, 'DDDDDDDDDD'],
      ['secret="never closed and secret.value', 'secret.value'],
    ];
    for (const [input, needle] of cases) {
      expect(redactString(input), input.slice(0, 40)).not.toContain(needle);
    }
  });

  it('stays linear on the shapes that restart a scan', () => {
    const inputs = [
      'secret="'.repeat(10_000),
      'password=\\"'.repeat(9_000),
      'token='.repeat(16_000),
      'Basic '.repeat(16_000),
      'authorization:'.repeat(7_000),
      'bearer '.repeat(14_000),
    ];
    for (const input of inputs) {
      const started = performance.now();
      redactString(input);
      expect(performance.now() - started, input.slice(0, 14)).toBeLessThan(400);
    }
  });

  it('leaves prose that merely contains Basic alone', () => {
    expect(redactString('Basic functionality is unchanged')).toBe(
      'Basic functionality is unchanged',
    );
  });
});

describe('scope names are plain and in canonical form', () => {
  const key = (scope: string[]) =>
    requirementsOf('m', { id: 'p', scope }).scopeKey;
  const invalid = (scope: string[]) =>
    requirementsOf('m', { id: 'p', scope }).invalid;

  it('refuses every other spelling of a repository, naming the one to write', () => {
    const spellings: Array<[string, string]> = [
      ['REPO:foo', 'repo:foo'],
      ['Repo:FOO/', 'repo:foo'],
      ['repo: foo ', 'repo:foo'],
      ['repo:foo.git', 'repo:foo'],
      ['repo:foo.GIT', 'repo:foo'],
      ['repo:a/b.git', 'repo:a/b'],
      ['repo :foo', 'repo:foo'],
    ];
    for (const [alias, canonical] of spellings) {
      expect(invalid([alias]), alias).toMatch(
        new RegExp(`write ${canonical.replace('/', '\\/')}$`),
      );
      expect(key([alias]), alias).toMatch(/^packet:/);
    }
    expect(invalid(['repo:foo', 'WorkTree:x'])).toMatch(/write worktree:x$/);
    expect(invalid(['repo:foo', 'worktree:x'])).toBeUndefined();
    expect(key(['repo:foo', 'worktree:x'])).toBe('repo:foo#worktree:x');
  });

  it('refuses a name that could point somewhere else', () => {
    for (const bad of [
      'repo:foo/.git',
      'repo:foo/.',
      'repo:foo/./.',
      'repo:x/../foo',
      'repo:a//b',
      'repo:/abs',
      'repo:.git',
      'repo:a b',
      'repo:a\\b',
    ]) {
      expect(invalid([bad]), bad).toBeDefined();
    }
    expect(invalid(['repo:a', 'worktree:a/../b'])).toBeDefined();
  });

  it('does not call one repository written twice the same way ambiguous', () => {
    expect(invalid(['repo:foo', 'repo:foo'])).toBeUndefined();
    expect(invalid(['repo:a', 'worktree:x', 'worktree:x'])).toBeUndefined();
    expect(invalid(['repo:foo', 'repo:bar'])).toBeDefined();
  });

  it('reads capability prefixes without regard to case', () => {
    expect(
      requirementsOf('m', { id: 'p', scope: ['CAP:docker'] }).capabilities,
    ).toEqual(['docker']);
  });

  it('is not bypassed by a spelling that policy never matched', async () => {
    const h = createFleetHarness();
    const a = await h.runner({
      name: 'a',
      allowedScopes: ['repo:*', 'REPO:*'],
    });
    for (const alias of [
      'repo:prod.git',
      'repo:prod/',
      'REPO:prod',
      'repo:Prod',
    ]) {
      const { id } = h.mission([{ scope: [alias] }]);
      h.tick();
      expect(h.getMission(id).attempts, alias).toHaveLength(0);
    }
    const res = await a.claim();
    expect(res.body.assignments).toEqual([]);
  });
});

describe('a reconciled lease', () => {
  it('is unconfirmed until the runner shows the new fence, so a lost answer is recoverable', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    const held = await hold(h, runner);
    await runner.heartbeat([evidence(held)]); // confirmed on fence 1
    expect(lease(h, held.leaseId).confirmed_at).not.toBeNull();
    h.clock.advance(TTL + 1_000);
    await runner.claim();
    await runner.reconcile(held.leaseId, 1); // the answer never arrives
    expect(lease(h, held.leaseId).confirmed_at).toBeNull();

    const poll = await runner.claim();
    expect(poll.body.assignments).toHaveLength(1);
    expect(poll.body.assignments[0]).toMatchObject({
      leaseId: held.leaseId,
      fence: 2,
    });
    const next = await runner.claim({
      active: [evidence({ ...held, fence: 2 })],
    });
    expect(next.body.assignments).toEqual([]);
  });

  it('is not handed its work back by reconcile once the runner is paused, narrowed or its mission paused', async () => {
    const h = createFleetHarness();
    const runner = await h.runner({ allowedScopes: ['repo:*'] });
    const held = await hold(h, runner);
    h.clock.advance(TTL + 1_000);
    await runner.claim();
    await h.call(h.owner.token, 'PATCH', `/runners/${runner.id}`, {
      paused: true,
    });
    const back = await runner.reconcile(held.leaseId, 1);
    expect(back.status).toBe(200);
    expect(back.body.assignment).toBeNull();
    expect(back.body.withheld).toBe('runner is paused');

    await h.call(h.owner.token, 'PATCH', `/runners/${runner.id}`, {
      paused: false,
      allowedScopes: ['repo:other'],
    });
    const again = await runner.reconcile(held.leaseId, 1);
    expect(again.body.withheld).toBe('scope repo:app is not allowed');
  });

  it('answers a reconcile with the work when nothing withholds it', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    const held = await hold(h, runner);
    h.clock.advance(TTL + 1_000);
    await runner.claim();
    const back = await runner.reconcile(held.leaseId, 1);
    expect(back.body.withheld).toBeNull();
    expect(back.body.assignment.fence).toBe(2);
  });
});

describe('quarantine and the pause toggle', () => {
  it('remembers a pause toggled while quarantined, and restores it', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    await h.call(h.owner.token, 'POST', `/runners/${runner.id}/quarantine`, {});
    await h.call(h.owner.token, 'PATCH', `/runners/${runner.id}`, {
      paused: true,
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

    await h.call(h.owner.token, 'POST', `/runners/${runner.id}/quarantine`, {});
    await h.call(h.owner.token, 'PATCH', `/runners/${runner.id}`, {
      paused: false,
    });
    const out = await h.call(
      h.owner.token,
      'POST',
      `/runners/${runner.id}/unquarantine`,
    );
    expect(out.body.runner.status).toBe('active');
    const updates = audit(h, 'runner.updated');
    expect(updates.at(-1)?.detail).toMatchObject({
      to: { status: 'quarantined', restoreTo: 'active' },
    });
  });

  it('clears its bookkeeping and leaves an audit trail', async () => {
    const h = createFleetHarness();
    const a = await h.runner({ name: 'a' });
    const held = await hold(h, a);
    await a.checkpoint(held.leaseId, {
      fence: 1,
      ref: 'refs/heads/t',
      commit: SHA,
    });
    await h.call(h.owner.token, 'POST', `/runners/${a.id}/quarantine`, {
      reason: 'odd',
    });
    h.db.run(
      'UPDATE runner_leases SET reassign_failures = 4, reassign_not_before = ?',
      ['2999-01-01T00:00:00.000Z'],
    );
    h.clock.advance(10_000);
    await h.call(h.owner.token, 'POST', `/runners/${a.id}/unquarantine`);

    const runner = h.db.get<{
      quarantine_reason: string | null;
      prior_status: string | null;
    }>('SELECT quarantine_reason, prior_status FROM runners WHERE id = ?', [
      a.id,
    ]);
    expect(runner).toEqual({ quarantine_reason: null, prior_status: null });
    expect(lease(h, held.leaseId)).toMatchObject({
      reassign_failures: 0,
      reassign_not_before: null,
    });
    expect(audit(h, 'runner.quarantined')[0]).toMatchObject({
      actorId: h.owner.actor.id,
      runnerId: a.id,
      detail: { reason: 'odd' },
    });
    expect(audit(h, 'runner.unquarantined')[0]).toMatchObject({
      actorId: h.owner.actor.id,
      detail: { restoredStatus: 'active' },
    });
  });

  it('records what a reconcile did and when the runner was seen', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    const held = await hold(h, runner);
    h.clock.advance(TTL + 1_000);
    h.db.run('UPDATE runner_leases SET reassign_failures = 3');
    await runner.claim();
    const before = h.db.get<{ last_seen_at: string }>(
      'SELECT last_seen_at FROM runners',
    )?.last_seen_at;
    h.clock.advance(5_000);
    await runner.reconcile(held.leaseId, 1);
    expect(
      h.db.get<{ last_seen_at: string }>('SELECT last_seen_at FROM runners')
        ?.last_seen_at,
    ).not.toBe(before);
    expect(lease(h, held.leaseId).reassign_failures).toBe(0);
    expect(audit(h, 'lease.reconciled')[0]?.detail).toMatchObject({
      fromFence: 1,
      toFence: 2,
    });
  });
});

describe('releasing an offer', () => {
  it('redacts its reason and records who released what', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    await runner.claim();
    const { id } = h.mission([{ scope: ['repo:one'] }]);
    h.tick();
    const attempt = h.getMission(id).attempts[0];
    const secret = `ghp_${'Qq1Ww2Ee3Rr4Tt5Yy6Uu7'}${'Ii8Oo9'}`;
    const res = await h.call(
      h.owner.token,
      'POST',
      `/runners/attempts/${attempt?.id}/release`,
      { reason: `leaked ${secret}` },
    );
    expect(res.body).toEqual({ attemptId: attempt?.id, missionId: id });
    const stored = JSON.stringify([
      h.db.all('SELECT * FROM events'),
      h.db.all('SELECT * FROM fleet_audit'),
    ]);
    expect(stored).not.toContain(secret);
    expect(audit(h, 'offer.released')[0]).toMatchObject({
      actorId: h.owner.actor.id,
      runnerId: runner.id,
      detail: { attemptId: attempt?.id },
    });
    expect(h.getMission(id).attempts[0]?.report?.summary).toContain(
      '[REDACTED]',
    );
  });

  it('says so when no reason was given, for an offer and for a lease', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    await runner.claim();
    const offerMission = h.mission([{ scope: ['repo:one'] }]);
    h.tick();
    const offer = h.getMission(offerMission.id).attempts[0];
    await h.call(
      h.owner.token,
      'POST',
      `/runners/attempts/${offer?.id}/release`,
      {},
    );
    expect(
      h.getMission(offerMission.id).attempts[0]?.report?.summary,
    ).toContain('no reason given');

    h.clock.advance(h.config.livenessWindowMs - 1);
    const held = await hold(h, runner, ['repo:two']);
    await h.call(
      h.owner.token,
      'POST',
      `/runners/leases/${held.leaseId}/release`,
      {},
    );
    expect(h.getMission(held.missionId).attempts[0]?.report?.summary).toContain(
      'no reason given',
    );
    expect(lease(h, held.leaseId).close_reason).toBe('no reason given');
  });
});

describe('progress replay', () => {
  it('treats the same sequence with other data as a conflict, and the same body as a replay', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    const held = await hold(h, runner);
    const body = { fence: 1, seq: 1, message: 'm', data: { a: 1 } };
    await runner.progress(held.leaseId, body);
    const conflict = await runner.progress(held.leaseId, {
      ...body,
      data: { a: 2 },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('progress_conflict');
    expect((await runner.progress(held.leaseId, body)).body.replayed).toBe(
      true,
    );
  });
});

describe('redelivery with capacity', () => {
  it('does not count the lease being resent against the runner', async () => {
    const h = createFleetHarness();
    const runner = await h.runner({ maxConcurrent: 1 });
    h.mission([{ scope: ['repo:one'] }]);
    const first = (await runner.claim()).body.assignments[0];
    const again = await runner.claim();
    expect(again.body.assignments[0]?.leaseId).toBe(first.leaseId);
    expect(again.body.withheld).toEqual([]);
  });
});

describe('pausing states', () => {
  for (const state of ['waiting-external', 'needs-attention'] as const) {
    it(`withholds offers and resends, and tells leases to pause, while a mission is ${state}`, async () => {
      const h = createFleetHarness();
      const runner = await h.runner({ maxConcurrent: 3 });
      const unconfirmed = await hold(h, runner, ['repo:one']);
      const confirmed = await hold(h, runner, ['repo:two']);
      await runner.heartbeat([evidence(confirmed)]);
      const offered = h.mission([{ scope: ['repo:three'] }]);
      h.tick();

      for (const id of [
        unconfirmed.missionId,
        confirmed.missionId,
        offered.id,
      ]) {
        const m = h.getMission(id);
        h.core.missions.transitionMission(
          h.ctx(),
          id,
          m.version,
          state,
          'blocked',
        );
      }
      const res = await runner.claim({ active: [evidence(confirmed)] });
      expect(res.body.assignments).toEqual([]);
      expect(
        res.body.withheld.map((w: { reason: string }) => w.reason),
      ).toEqual([`mission is ${state}`, `mission is ${state}`]);
      expect(res.body.leases[0].directives.pause).toBe(true);
    });
  }
});

describe('checkpoint order', () => {
  it('uses the latest checkpoint for resume, reconcile and reassignment, and lists them in order', async () => {
    const h = createFleetHarness();
    const a = await h.runner({ name: 'a' });
    const b = await h.runner({ name: 'b' });
    const held = await hold(h, a);
    await a.progress(held.leaseId, { fence: 1, seq: 1, message: 'one' });
    await a.progress(held.leaseId, { fence: 1, seq: 2, message: 'two' });
    await a.checkpoint(held.leaseId, {
      fence: 1,
      ref: 'refs/heads/c1',
      commit: SHA,
    });
    await a.checkpoint(held.leaseId, {
      fence: 1,
      ref: 'refs/heads/c2',
      commit: SHA2,
    });

    const detail = await h.call(
      h.owner.token,
      'GET',
      `/runners/leases/${held.leaseId}`,
    );
    expect(detail.body.checkpoints.map((c: { ref: string }) => c.ref)).toEqual([
      'refs/heads/c1',
      'refs/heads/c2',
    ]);
    expect(detail.body.progress.map((p: { seq: number }) => p.seq)).toEqual([
      1, 2,
    ]);

    h.clock.advance(TTL + GRACE + 1_000);
    const moved = await b.claim();
    expect(moved.body.assignments[0].resume).toEqual({
      progressSeq: 2,
      checkpoint: { ref: 'refs/heads/c2', commit: SHA2 },
    });
    expect(audit(h, 'lease.reassigned')[0]?.detail).toMatchObject({
      checkpoint: 'refs/heads/c2',
      commit: SHA2,
      from: a.id,
      to: b.id,
    });
  });

  it('reports the latest checkpoint on reconcile', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    const held = await hold(h, runner);
    await runner.checkpoint(held.leaseId, { fence: 1, ref: 'refs/heads/c1' });
    await runner.checkpoint(held.leaseId, { fence: 1, ref: 'refs/heads/c2' });
    h.clock.advance(TTL + 1_000);
    await runner.claim();
    const back = await runner.reconcile(held.leaseId, 1);
    expect(back.body.resume.checkpoint.ref).toBe('refs/heads/c2');
    expect(back.body.assignment.resume.checkpoint.ref).toBe('refs/heads/c2');
  });

  it('reports no resume point when there is neither progress nor a checkpoint, and one when there is either', async () => {
    const h = createFleetHarness();
    const runner = await h.runner({ maxConcurrent: 3 });
    const none = await hold(h, runner, ['repo:one']);
    await runner.heartbeat([evidence(none)]);
    const progressOnly = await hold(h, runner, ['repo:two']);
    const checkpointOnly = await hold(h, runner, ['repo:three']);
    await runner.progress(progressOnly.leaseId, {
      fence: 1,
      seq: 1,
      message: 'x',
    });
    await runner.checkpoint(checkpointOnly.leaseId, {
      fence: 1,
      ref: 'refs/heads/x',
    });
    h.clock.advance(TTL + 1_000);
    await runner.claim();
    const resume = async (held: Held) =>
      (await runner.reconcile(held.leaseId, 1)).body.assignment.resume;
    expect(await resume(none)).toBeNull();
    expect(await resume(progressOnly)).toEqual({
      progressSeq: 1,
      checkpoint: null,
    });
    expect(await resume(checkpointOnly)).toEqual({
      progressSeq: 0,
      checkpoint: { ref: 'refs/heads/x', commit: null },
    });
  });
});

describe('actors on events', () => {
  it('starts an attempt as the runner and relays a reassigned receipt as the disabled fleet principal', async () => {
    const h = createFleetHarness();
    const a = await h.runner({ name: 'a' });
    const b = await h.runner({ name: 'b' });
    const held = await hold(h, a);
    expect(
      h.db.get<{ actor_id: string }>(
        "SELECT actor_id FROM events WHERE type = 'attempt.started'",
      )?.actor_id,
    ).toBe(a.id);
    await a.checkpoint(held.leaseId, { fence: 1, ref: 'refs/heads/t' });
    h.clock.advance(TTL + GRACE + 1_000);
    const next = (await b.claim()).body.assignments[0];
    await b.receipt(next.leaseId, {
      receiptId: 'b1',
      fence: next.fence,
      outcome: 'succeeded',
      summary: 'ok',
    });

    const fleet = `prn_fleet_${TEST_WORKSPACE}`;
    expect(
      h.db.get<{ actor_id: string }>(
        "SELECT actor_id FROM events WHERE type = 'attempt.reported'",
      )?.actor_id,
    ).toBe(fleet);
    expect(
      h.db.get('SELECT kind, disabled_at FROM principals WHERE id = ?', [
        fleet,
      ]),
    ).toMatchObject({ kind: 'chief_of_staff' });
    expect(
      h.db.get<{ disabled_at: string | null }>(
        'SELECT disabled_at FROM principals WHERE id = ?',
        [fleet],
      )?.disabled_at,
    ).not.toBeNull();
    expect(
      h.db.all('SELECT id FROM api_tokens WHERE principal_id = ?', [fleet]),
    ).toEqual([]);
  });
});

describe('operator views are current', () => {
  it('shows an expired lease as recovering without any other fleet call', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    const held = await hold(h, runner);
    h.clock.advance(TTL + 1_000);
    const list = await h.call(h.owner.token, 'GET', '/runners/leases');
    expect(list.body.leases[0].status).toBe('recovering');

    const h2 = createFleetHarness();
    const r2 = await h2.runner();
    const held2 = await hold(h2, r2);
    h2.clock.advance(TTL + 1_000);
    const one = await h2.call(
      h2.owner.token,
      'GET',
      `/runners/leases/${held2.leaseId}`,
    );
    expect(one.body.lease.status).toBe('recovering');
    expect(held.leaseId).toBeTruthy();
  });
});

describe('workspaces share nothing in the fleet', () => {
  it('lets another workspace take the same repo scope, and keeps its views apart', async () => {
    const h = createFleetHarness();
    const a = await h.runner();
    const heldA = await hold(h, a, ['repo:x']);

    const other = seedPrincipal(h.db, { kind: 'human', workspaceId: 'ws_b' });
    const actorB = { id: other.principalId, kind: 'human' as const };
    const ctxB = { workspaceId: 'ws_b', actor: actorB };
    const created = h.core.missions.createMission(ctxB, mission());
    let state = h.core.missions.transitionMission(
      ctxB,
      created.mission.id,
      created.mission.version,
      'ready',
      null,
    ).mission;
    state = h.core.missions.addPacket(ctxB, state.id, state.version, {
      title: 'p',
      instructions: 'b work',
      scope: ['repo:x'],
      required: true,
      dependsOn: [],
    }).mission;
    h.core.missions.authorizePacket(
      ctxB,
      state.id,
      state.version,
      state.packets[0]?.id ?? '',
      [],
    );

    const enrolled = await h.call(other.token, 'POST', '/runners/enrollments', {
      name: 'b',
      version: VERSION,
      buildDigest: DIGEST,
      allowedScopes: ['*'],
    });
    const registered = await h.call(
      enrolled.body.enrollment.token,
      'POST',
      '/runners/register',
      { version: VERSION, buildDigest: DIGEST, capabilities: [] },
    );
    const b = clientFor(
      h.call,
      registered.body.runnerId,
      registered.body.token,
    );

    const mine = await b.claim();
    expect(mine.body.assignments).toHaveLength(1);
    expect(mine.body.assignments[0].fence).toBe(1);
    expect(mine.body.assignments[0].packet.instructions).toBe('b work');

    const leasesB = await h.call(other.token, 'GET', '/runners/leases');
    expect(leasesB.body.leases).toHaveLength(1);
    expect(leasesB.body.leases[0].workspaceId).toBe('ws_b');
    expect(
      (await h.call(other.token, 'GET', `/runners/leases/${heldA.leaseId}`))
        .status,
    ).toBe(404);
    const auditB = await h.call(other.token, 'GET', '/runners/audit?limit=500');
    expect(JSON.stringify(auditB.body)).not.toContain(heldA.leaseId);
    expect(JSON.stringify(auditB.body)).not.toContain(a.id);
    const runnersB = await h.call(other.token, 'GET', '/runners');
    expect(runnersB.body.runners.map((r: { id: string }) => r.id)).toEqual([
      b.id,
    ]);
    expect(runnersB.body.runners[0].load).toBe(1);
    // A's lease was never touched by B's sweeps.
    expect(lease(h, heldA.leaseId).status).toBe('held');
  });
});

describe('broker ordering details', () => {
  it('breaks a tie on id, and keeps a runner live exactly up to the window', async () => {
    const h = createFleetHarness();
    const x = await h.runner({ name: 'x', maxConcurrent: 3 });
    const y = await h.runner({ name: 'y', maxConcurrent: 3 });
    await x.claim();
    await y.claim();
    const lo = x.id < y.id ? x : y;
    const { id } = h.mission([{ scope: ['repo:one'] }]);
    h.tick();
    expect(h.getMission(id).attempts[0]?.runnerId).toBe(lo.id);

    h.clock.advance(h.config.livenessWindowMs);
    const edge = h.mission([{ scope: ['repo:two'] }]);
    h.tick();
    expect(h.getMission(edge.id).attempts).toHaveLength(1);
    h.clock.advance(1);
    const past = h.mission([{ scope: ['repo:three'] }]);
    h.tick();
    expect(h.getMission(past.id).attempts).toHaveLength(0);
  });

  it('tells a loser how long to wait, and records what a grant was', async () => {
    const h = createFleetHarness({
      config: { backoff: { baseMs: 1_000, capMs: 8_000 } },
    });
    const a = await h.runner({ name: 'a' });
    const b = await h.runner({ name: 'b' });
    await a.claim();
    await b.claim();
    h.mission([{ scope: ['repo:app'] }, { scope: ['repo:app'] }]);
    h.tick();
    const [ra, rb] = await Promise.all([a.claim(), b.claim()]);
    const winner = ra.body.assignments.length === 1 ? ra : rb;
    const loser = winner === ra ? rb : ra;
    expect(loser.body.retryAfterMs).toBe(1_000);
    expect(loser.body.withheld[0].reason).toBe(
      'another runner holds the execution scope',
    );
    const granted = audit(h, 'lease.granted')[0];
    expect(granted?.detail).toMatchObject({
      scopeKey: 'repo:app#worktree:default',
      fence: 1,
    });

    const loserClient = winner === ra ? b : a;
    h.clock.advance(400);
    const waiting = await loserClient.claim();
    expect(waiting.body.retryAfterMs).toBe(600);
    expect(waiting.body.withheld[0].reason).toMatch(/backing off/);
  });
});

describe('registration leaves a trail and cannot be repeated by a bypass', () => {
  it('revokes the enrollment token, marks the enrollment used, and refuses a second direct redemption', async () => {
    const h = createFleetHarness();
    const enrolled = await h.enroll();
    const token = enrolled.body.enrollment.token as string;
    const row = h.db.get<{ token_id: string; principal_id: string }>(
      'SELECT token_id, principal_id FROM runner_enrollments',
    );
    const registered = await h.call(token, 'POST', '/runners/register', {
      version: VERSION,
      buildDigest: DIGEST,
      capabilities: [],
    });
    expect(registered.status).toBe(201);
    expect(
      h.db.get<{ revoked_at: string | null }>(
        'SELECT revoked_at FROM api_tokens WHERE id = ?',
        [row?.token_id ?? ''],
      )?.revoked_at,
    ).not.toBeNull();
    expect(
      h.db.get('SELECT used_at, runner_id FROM runner_enrollments'),
    ).toMatchObject({ runner_id: row?.principal_id });
    expect(
      h.db.get<{ used_at: string | null }>(
        'SELECT used_at FROM runner_enrollments',
      )?.used_at,
    ).not.toBeNull();

    let caught: unknown;
    try {
      h.fleet.register(
        { workspaceId: TEST_WORKSPACE, tokenId: row?.token_id ?? '' },
        { version: VERSION, buildDigest: DIGEST, capabilities: [] },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FleetError);
    expect((caught as FleetError).message).toBe(
      'The enrollment was already used',
    );
  });

  it('refuses a direct redemption of an expired enrollment', async () => {
    const h = createFleetHarness();
    const enrolled = await h.enroll({ expiresInSeconds: 60 });
    const row = h.db.get<{ token_id: string }>(
      'SELECT token_id FROM runner_enrollments',
    );
    h.clock.advance(61_000);
    expect(() =>
      h.fleet.register(
        { workspaceId: TEST_WORKSPACE, tokenId: row?.token_id ?? '' },
        { version: VERSION, buildDigest: DIGEST, capabilities: [] },
      ),
    ).toThrow('The enrollment expired');
    expect(enrolled.status).toBe(201);
  });
});
