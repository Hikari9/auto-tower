import { describe, expect, it } from 'vitest';
import {
  engageHalt,
  HaltForbiddenError,
  haltHistory,
  haltState,
  healthReport,
  liftHalt,
  requireNotHalted,
  WorkspaceHaltedError,
} from '../../src/ops/index.js';
import { createFleetHarness } from '../fleet/helpers.js';
import { TEST_WORKSPACE } from '../helpers/tower.js';
import {
  completeMission,
  configure,
  createIssueHarness,
  grantClose,
  ISSUE_URL,
  missionWithLinks,
} from '../issues/helpers.js';
import { key } from '../mcp/helpers.js';
import { createMcpEnv } from '../mcp/setup.js';

const halt = (h: ReturnType<typeof createFleetHarness>, reason = 'drill') =>
  engageHalt(h.db, {
    workspaceId: TEST_WORKSPACE,
    actor: h.owner.actor,
    reason,
    now: h.clock.now(),
  });

const resume = (h: ReturnType<typeof createFleetHarness>) =>
  liftHalt(h.db, {
    workspaceId: TEST_WORKSPACE,
    actor: h.owner.actor,
    reason: 'drill over',
    now: h.clock.now(),
  });

/** Rows that say what the workspace's work looks like. A halt must change none of them. */
function workState(h: ReturnType<typeof createFleetHarness>) {
  const rows = (sql: string) => JSON.stringify(h.db.all(sql));
  return [
    rows('SELECT * FROM missions ORDER BY id'),
    rows('SELECT * FROM work_packets ORDER BY id'),
    rows('SELECT * FROM execution_attempts ORDER BY id'),
    rows('SELECT * FROM runner_leases ORDER BY id'),
    rows('SELECT * FROM events ORDER BY seq'),
    rows('SELECT * FROM policy_rules ORDER BY id'),
  ].join('\n');
}

describe('emergency halt state', () => {
  it('starts running, halts with a reason and identity, and records every change', () => {
    const h = createFleetHarness();
    expect(haltState(h.db, TEST_WORKSPACE)).toMatchObject({ halted: false });
    const halted = halt(h, 'suspected credential leak');
    expect(halted).toMatchObject({
      halted: true,
      reason: 'suspected credential leak',
      changedBy: h.owner.actor.id,
    });
    expect(() => requireNotHalted(h.db, TEST_WORKSPACE, 'Dispatch')).toThrow(
      WorkspaceHaltedError,
    );
    expect(resume(h).halted).toBe(false);
    expect(
      haltHistory(h.db, TEST_WORKSPACE, { afterSeq: 0, limit: 10 }).map((c) => [
        c.action,
        c.reason,
        c.actorId,
      ]),
    ).toEqual([
      ['halt', 'suspected credential leak', h.owner.actor.id],
      ['resume', 'drill over', h.owner.actor.id],
    ]);
  });

  it('is for a person only: a chief of staff, runner or provider cannot halt or resume', () => {
    const h = createFleetHarness();
    for (const kind of [
      'chief_of_staff',
      'runner',
      'provider_adapter',
    ] as const) {
      const actor = { id: h.cos.actor.id, kind };
      expect(() =>
        engageHalt(h.db, { workspaceId: TEST_WORKSPACE, actor, reason: null }),
      ).toThrow(HaltForbiddenError);
    }
    halt(h);
    expect(() =>
      liftHalt(h.db, {
        workspaceId: TEST_WORKSPACE,
        actor: h.cos.actor,
        reason: null,
      }),
    ).toThrow(HaltForbiddenError);
    expect(haltState(h.db, TEST_WORKSPACE).halted).toBe(true);
  });

  it('keeps its history append-only', () => {
    const h = createFleetHarness();
    halt(h);
    expect(() => h.db.run('UPDATE ops_halt_history SET reason = NULL')).toThrow(
      /append-only/,
    );
    expect(() => h.db.run('DELETE FROM ops_halt_history')).toThrow(
      /append-only/,
    );
  });

  it('bounds the reason and treats a blank one as none', () => {
    const h = createFleetHarness();
    expect(halt(h, 'x'.repeat(2000)).reason).toHaveLength(500);
    expect(halt(h, '   ').reason).toBeNull();
  });

  it('shows as the health status, above any degraded signal', () => {
    const h = createFleetHarness();
    expect(healthReport(h.db, TEST_WORKSPACE).status).toBe('ok');
    halt(h);
    expect(healthReport(h.db, TEST_WORKSPACE)).toMatchObject({
      status: 'halted',
      halt: { halted: true },
    });
  });
});

describe('a halt stops new dispatch and keeps everything else', () => {
  it('offers no work to a polling runner, changes no row, and resumes where it stopped', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    await runner.claim();
    const { id } = h.mission([{ scope: ['repo:app'] }]);
    h.tick();
    const attempts = h.getMission(id).attempts;
    expect(attempts).toHaveLength(1);

    halt(h);
    const before = workState(h);
    const held = await runner.claim();
    expect(held.status).toBe(200);
    expect(held.body.assignments).toEqual([]);
    expect(held.body.withheld).toEqual([
      {
        attemptId: attempts[0]?.id,
        reason: 'emergency halt: dispatch is stopped',
      },
    ]);
    // The poll's heartbeat may be recorded, but no work state moved.
    expect(workState(h)).toBe(before);
    // Not even the scheduler's own bookkeeping ran: a packet that was waiting stays waiting.
    const { id: second } = h.mission([{ scope: ['repo:other'] }]);
    h.db.run(
      "UPDATE work_packets SET status = 'pending' WHERE mission_id = ?",
      [second],
    );
    const frozen = workState(h);
    await runner.claim();
    expect(workState(h)).toBe(frozen);

    resume(h);
    const resumed = await runner.claim();
    // The packet that was waiting before the halt, and the one added during it, both run now.
    expect(
      resumed.body.assignments.map((a: { attemptId: string }) => a.attemptId),
    ).toContain(attempts[0]?.id);
    expect(resumed.body.assignments).toHaveLength(2);
  });

  it('dispatches nothing new from the scheduler, and dispatches the waiting work once lifted', async () => {
    const h = createFleetHarness();
    await (await h.runner()).claim();
    halt(h);
    const { id } = h.mission([{ scope: ['repo:app'] }]);
    h.tick();
    expect(h.getMission(id).attempts).toEqual([]);
    expect(h.getMission(id).packets[0]?.status).toBe('ready');

    resume(h);
    h.tick();
    expect(h.getMission(id).attempts).toHaveLength(1);
  });

  it('does not take a lease back from a runner that already confirmed it', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    await runner.claim();
    h.mission([{ scope: ['repo:app'] }]);
    h.tick();
    const claimed = await runner.claim();
    const lease = claimed.body.assignments[0];
    await runner.heartbeat([
      {
        leaseId: lease.leaseId,
        attemptId: lease.attemptId,
        fence: lease.fence,
        progressSeq: 0,
      },
    ]);
    halt(h);
    const progress = await runner.progress(lease.leaseId, {
      fence: lease.fence,
      seq: 1,
      message: 'still working',
    });
    expect(progress.status).toBe(201);
    expect(
      h.db.get<{ status: string }>('SELECT status FROM runner_leases')?.status,
    ).toBe('held');
  });
});

describe('a halt stops a recovering runner from taking its lease back', () => {
  it('withholds on reconcile, reissues no fence, and lets it reconcile once resumed', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    await runner.claim();
    h.mission([{ scope: ['repo:app'] }]);
    h.tick();
    const granted = (await runner.claim()).body.assignments[0];
    // The runner goes quiet past the lease TTL, so the lease moves to recovery. Then a person halts.
    h.clock.advance(h.config.leaseTtlMs + 1000);
    h.fleet.sweep(TEST_WORKSPACE);
    halt(h, 'incident');
    const lease = () =>
      h.db.get<{ fence: number; status: string; expires_at: string }>(
        'SELECT fence, status, expires_at FROM runner_leases WHERE id = ?',
        [granted.leaseId],
      );
    const before = lease();
    expect(before?.status).toBe('recovering');

    const held = await runner.reconcile(granted.leaseId, granted.fence);
    expect(held.status).toBe(200);
    expect(held.body.assignment).toBeNull();
    expect(held.body.withheld).toBe('emergency halt: dispatch is stopped');
    // Nothing moved: no new fence, no renewed lease, still recovering.
    expect(held.body.lease.fence).toBe(granted.fence);
    expect(lease()).toEqual(before);
    expect(h.db.all('SELECT id FROM runner_leases')).toHaveLength(1);

    resume(h);
    const after = await runner.reconcile(granted.leaseId, granted.fence);
    expect(after.body.assignment).not.toBeNull();
    expect(after.body.withheld).toBeNull();
    expect(after.body.lease.fence).toBeGreaterThan(granted.fence);
  });
});

describe('a halt stops guarded effects', () => {
  it('refuses to close a provider issue, writes nothing outward, and allows it again once lifted', async () => {
    const h = createIssueHarness();
    h.github.add(ISSUE_URL);
    configure(h);
    grantClose(h);
    const driver = missionWithLinks(h);
    driver.verifyOutcome();
    engageHalt(h.db, {
      workspaceId: TEST_WORKSPACE,
      actor: h.owner,
      reason: 'incident',
      now: h.clock.now(),
    });

    const report = await h.issues.closeRequired(h.ctx(h.cos), driver.id);
    expect(h.github.closeCalls).toBe(0);
    expect(report.results[0]?.status).toBe('policy_denied');
    expect(report.satisfied).toBe(false);
    expect(h.github.issue(ISSUE_URL).state).toBe('open');
    // The refusal is on record as a halt, not as a missing grant.
    expect(
      h.db.get<{ code: string }>(
        'SELECT code FROM policy_receipts ORDER BY seq DESC',
      )?.code,
    ).toBe('workspace_halted');
    expect(() => completeMission(driver)).toThrow();

    liftHalt(h.db, {
      workspaceId: TEST_WORKSPACE,
      actor: h.owner,
      reason: null,
      now: h.clock.now(),
    });
    const after = await h.issues.closeRequired(h.ctx(h.cos), driver.id);
    expect(h.github.closeCalls).toBe(1);
    expect(after.satisfied).toBe(true);
  });
});

describe('the halt tools', () => {
  it('lets a person halt and resume over MCP, and refuses everyone else', async () => {
    const env = createMcpEnv();
    const owner = await env.session(env.owner);
    const cos = await env.session(env.cos);
    const refused = await cos.call('halt_workspace', {
      reason: 'x',
      confirm: true,
      idempotencyKey: key(),
    });
    expect(refused.status).toBe(403);

    expect(
      (
        await owner.call('halt_workspace', {
          reason: 'x',
          idempotencyKey: key(),
        })
      ).data.error.code,
    ).toBe('confirmation_required');
    const halted = await owner.ok('halt_workspace', {
      reason: 'revoking a leaked credential',
      confirm: true,
      idempotencyKey: key(),
    });
    expect(halted.halt).toMatchObject({ halted: true });

    // A person or a chief of staff can read it. A runner or a provider cannot: it names halt
    // reasons, who halted, and internal failures.
    const runner = await env.session(env.runner);
    expect((await runner.call('read_health', {})).status).toBe(403);
    const seen = await cos.ok('read_health', {});
    expect(seen.health.status).toBe('halted');
    expect(seen.haltHistory[0]).toMatchObject({
      action: 'halt',
      reason: 'revoking a leaked credential',
    });

    const resumed = await owner.ok('resume_workspace', {
      confirm: true,
      idempotencyKey: key(),
    });
    expect(resumed.halt).toMatchObject({ halted: false });
    expect((await cos.ok('read_health', {})).health.status).toBe('ok');
  });

  it('never lets a late retry undo a newer decision, and answers it with the state now', async () => {
    const env = createMcpEnv();
    const owner = await env.session(env.owner);
    const haltKey = key('halt');
    const resumeKey = key('resume');
    const health = async () =>
      (await owner.ok('read_health', {})).health.status;

    await owner.ok('halt_workspace', {
      reason: 'a',
      confirm: true,
      idempotencyKey: haltKey,
    });
    await owner.ok('resume_workspace', {
      confirm: true,
      idempotencyKey: resumeKey,
    });
    expect(await health()).toBe('ok');

    // A delayed retry of the first halt. It must not halt again, and it must not say `halted: true`.
    const lateHalt = await owner.call('halt_workspace', {
      reason: 'a',
      confirm: true,
      idempotencyKey: haltKey,
    });
    expect(lateHalt.isError).toBe(false);
    expect(lateHalt.meta?.['tower/replayed']).toBe(true);
    expect(lateHalt.data.halt.halted).toBe(false);
    expect(await health()).toBe('ok');

    // A newer, deliberate halt. A delayed retry of the older resume must not lift it.
    await owner.ok('halt_workspace', {
      reason: 'b',
      confirm: true,
      idempotencyKey: key(),
    });
    const lateResume = await owner.call('resume_workspace', {
      confirm: true,
      idempotencyKey: resumeKey,
    });
    expect(lateResume.meta?.['tower/replayed']).toBe(true);
    expect(lateResume.data.halt.halted).toBe(true);
    expect(await health()).toBe('halted');

    // Each effect ran once: two halts and one resume, however often they were retried.
    expect(
      env.db
        .all<{ action: string }>(
          'SELECT action FROM ops_halt_history ORDER BY seq',
        )
        .map((r) => r.action),
    ).toEqual(['halt', 'resume', 'halt']);
    // The key is still bound to its call: reusing it for different arguments is refused.
    const reused = await owner.call('halt_workspace', {
      reason: 'other',
      confirm: true,
      idempotencyKey: haltKey,
    });
    expect(reused.data.error.code).toBe('idempotency_key_reused');
  });

  it('still replays an ordinary tool for the same key, so the exception is only for these', async () => {
    const env = createMcpEnv();
    const owner = await env.session(env.owner);
    const args = {
      title: 't',
      intent: 'i',
      outcome: 'o',
      idempotencyKey: key('c'),
    };
    const a = await owner.call('create_mission', args);
    const b = await owner.call('create_mission', args);
    expect(b.meta?.['tower/replayed']).toBe(true);
    expect(b.data.mission.id).toBe(a.data.mission.id);
  });
});
