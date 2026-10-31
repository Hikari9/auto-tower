// Regressions for defects found by an independent review (F1-F10). Each test forces
// the interleaving or input that used to break an invariant.
import { describe, expect, it } from 'vitest';
import type { Mission } from '../src/domain/types.ts';
import type { SqlValue, Stmt } from '../src/store/sql.ts';
import { completion, makeHarness, receipt, registerRunner, simpleMission } from './harness.ts';

const LEASE = 90_000;

describe('review regressions', () => {
  it('F1: a runner cannot lower an effect’s risk below its packet’s', async () => {
    const h = await makeHarness();
    await h.tower.policy.grant(h.owner, { action: 'db.migrate', resource: '*', grantee: 'runner', conditions: { maxRisk: 'low' } });
    await h.tower.missions.create(h.owner, simpleMission({ risk: 'high' }));
    const a = await registerRunner(h, 'A');
    const c = (await h.tower.runners.claim(a))!;
    await expect(h.tower.runners.authorizeEffect(a, { attemptId: c.attempt.id, fence: c.attempt.fence, action: 'db.migrate', resource: 'db:main', risk: 'low' })).rejects.toMatchObject({ code: 'policy_denied' });
    const ex = await h.tower.runners.requestExpansion(a, { attemptId: c.attempt.id, fence: c.attempt.fence, action: 'pkg.add', resource: 'npm:x', reason: 'r', risk: 'low' });
    expect((await h.tower.decisions.get(h.owner, ex.decisionId!)).requiredAuthority.risk).toBe('high');
  });

  it('F2: wildcard envelopes never reach sensitive actions, and a chief cannot create them', async () => {
    const h = await makeHarness();
    await expect(h.tower.missions.create(h.chief, simpleMission({ start: false, authority: { actions: ['*'], resources: ['*'] } }))).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(h.tower.missions.create(h.chief, simpleMission({ start: false, authority: { actions: ['deploy.*'], resources: ['*'] } }))).rejects.toMatchObject({ code: 'policy_denied' });
    await h.tower.missions.create(h.owner, simpleMission({ authority: { actions: ['*'], resources: ['*'] } }));
    const a = await registerRunner(h, 'A');
    const c = (await h.tower.runners.claim(a))!;
    const eff = (action: string, resource: string) => h.tower.runners.authorizeEffect(a, { attemptId: c.attempt.id, fence: c.attempt.fence, action, resource });
    await expect(eff('repo.push', 'repo:acme/app')).resolves.toMatchObject({ allowed: true });
    await expect(eff('deploy.prod', 'env:prod')).rejects.toMatchObject({ code: 'policy_denied' });
    await expect(eff('spend.usd', 'vendor:x')).rejects.toMatchObject({ code: 'policy_denied' });
  });

  it('F3: a heartbeat racing a quarantine cannot bring the runner back online', async () => {
    const h = await makeHarness();
    const a = await registerRunner(h, 'A');
    const r = (await h.tower.repo.runnerByPrincipal(a.principal.id))!;
    const orig = h.db.batch.bind(h.db);
    let fired = false;
    h.db.batch = async (stmts: Stmt[]) => {
      if (!fired && stmts[0]?.sql.startsWith('UPDATE runners SET last_seen_at')) {
        fired = true;
        await h.tower.runners.quarantine(h.owner, r.id, 'compromised');
      }
      return orig(stmts);
    };
    const hb = await h.tower.runners.heartbeat(a, { attempts: [] });
    expect(fired).toBe(true);
    expect(hb.status).toBe('quarantined');
    expect((await h.tower.repo.runner(h.workspaceId, r.id)).status).toBe('quarantined');
    await h.tower.missions.create(h.owner, simpleMission());
    expect(await h.tower.runners.claim(a)).toBeNull();
  });

  it('F4: a reopen racing completion leaves the mission reconciling, never completed with an open required issue', async () => {
    const h = await makeHarness();
    const m = await h.tower.missions.create(h.owner, simpleMission({ links: [{ url: 'https://example.com/issues/1', role: 'required' }] }));
    const link = (await h.tower.repo.links(h.workspaceId, m.id))[0]!;
    await h.tower.issues.attest(h.owner, link.id, 'closed');
    const orig = h.db.batch.bind(h.db);
    let fired = false;
    h.db.batch = async (stmts: Stmt[]) => {
      if (!fired && stmts.some((s) => s.params.includes('mission.completed' as SqlValue))) {
        fired = true;
        await h.tower.issues.applyObservation(h.workspaceId, link.id, 'open', 'webhook');
      }
      return orig(stmts);
    };
    const a = await registerRunner(h, 'A');
    const c = (await h.tower.runners.claim(a))!;
    await h.tower.runners.report(a, receipt(c.attempt.id, c.attempt.fence, 'complete', { completion: completion() }));
    expect(fired).toBe(true);
    expect((await h.tower.repo.mission(h.workspaceId, m.id)).state).toBe('reconciling');
    expect((await h.tower.repo.link(h.workspaceId, link.id)).observedState).toBe('open');
  });

  it('F5a: work added while reconciling reopens the mission', async () => {
    const h = await makeHarness();
    const m = await h.tower.missions.create(h.owner, simpleMission({ links: [{ url: 'https://example.com/issues/1', role: 'required' }] }));
    const a = await registerRunner(h, 'A');
    const c = (await h.tower.runners.claim(a))!;
    await h.tower.runners.report(a, receipt(c.attempt.id, c.attempt.fence, 'complete', { completion: completion() }));
    expect((await h.tower.repo.mission(h.workspaceId, m.id)).state).toBe('reconciling');
    const p = await h.tower.missions.addPacket(h.owner, m.id, { title: 'more', goal: 'more work' });
    await h.tower.issues.attest(h.owner, (await h.tower.repo.links(h.workspaceId, m.id))[0]!.id, 'closed');
    expect((await h.tower.repo.mission(h.workspaceId, m.id)).state).toBe('active');
    expect((await h.tower.repo.packet(h.workspaceId, p.id)).state).toBe('ready');
  });

  it('F5b: the owner attesting a required issue reopened after completion raises a discrepancy', async () => {
    const h = await makeHarness();
    const m = await h.tower.missions.create(h.owner, simpleMission({ links: [{ url: 'https://example.com/issues/1', role: 'required' }] }));
    const link = (await h.tower.repo.links(h.workspaceId, m.id))[0]!;
    await h.tower.issues.attest(h.owner, link.id, 'closed');
    const a = await registerRunner(h, 'A');
    const c = (await h.tower.runners.claim(a))!;
    await h.tower.runners.report(a, receipt(c.attempt.id, c.attempt.fence, 'complete', { completion: completion() }));
    expect((await h.tower.repo.mission(h.workspaceId, m.id)).state).toBe('completed');
    await h.tower.issues.attest(h.owner, link.id, 'open', 'customer reopened it');
    const after = await h.tower.repo.mission(h.workspaceId, m.id);
    expect(after.state).toBe('needs_attention');
    expect(after.discrepancies[0]!.kind).toBe('reopened');
  });

  it('F6: approving an expansion after the runner was lost does not restart the work elsewhere', async () => {
    const h = await makeHarness();
    const m = await h.tower.missions.create(h.owner, simpleMission());
    const a = await registerRunner(h, 'A');
    const c = (await h.tower.runners.claim(a))!;
    const ex = await h.tower.runners.requestExpansion(a, { attemptId: c.attempt.id, fence: c.attempt.fence, action: 'pr.merge', resource: 'repo:acme/app', reason: 'need it' });
    h.clock.advance(LEASE + 1000);
    await h.tower.scheduler.sweep();
    await h.tower.decisions.answer(h.owner, ex.decisionId!, { approved: true });
    expect((await h.tower.repo.packets(h.workspaceId, m.id))[0]!.state).toBe('recovering');
    const b = await registerRunner(h, 'B');
    expect(await h.tower.runners.claim(b)).toBeNull();
    // The original runner comes back and simply continues.
    const hb = await h.tower.runners.heartbeat(a, { attempts: [{ attemptId: c.attempt.id, fence: c.attempt.fence }] });
    expect(hb.directives[0]!.action).toBe('continue');
  });

  it('F7: a runner reconnecting after its packet became reassignable resumes instead of deadlocking', async () => {
    const h = await makeHarness();
    const m = await h.tower.missions.create(h.owner, simpleMission());
    const a = await registerRunner(h, 'A');
    const c = (await h.tower.runners.claim(a))!;
    await h.tower.runners.report(a, receipt(c.attempt.id, c.attempt.fence, 'checkpoint', { checkpoint: { portable: true, kind: 'branch', ref: 'b', sha: 'abc1234' } }));
    h.clock.advance(LEASE + 1000);
    await h.tower.scheduler.sweep();
    h.clock.advance(LEASE * 2);
    await h.tower.scheduler.sweep();
    expect((await h.tower.repo.packets(h.workspaceId, m.id))[0]!.state).toBe('ready');
    const hb = await h.tower.runners.heartbeat(a, { attempts: [{ attemptId: c.attempt.id, fence: c.attempt.fence }] });
    expect(hb.directives[0]!.action).toBe('continue');
    expect((await h.tower.repo.packets(h.workspaceId, m.id))[0]!.state).toBe('running');
    const b = await registerRunner(h, 'B');
    expect(await h.tower.runners.claim(b)).toBeNull();
    await h.tower.runners.report(a, receipt(c.attempt.id, c.attempt.fence, 'complete', { completion: completion() }));
    expect((await h.tower.repo.mission(h.workspaceId, m.id)).state).toBe('completed');
  });

  it('F7b: a complete receipt straight from a lost attempt is accepted while it still holds the fence', async () => {
    const h = await makeHarness();
    const m = await h.tower.missions.create(h.owner, simpleMission());
    const a = await registerRunner(h, 'A');
    const c = (await h.tower.runners.claim(a))!;
    h.clock.advance(LEASE + 1000);
    await h.tower.scheduler.sweep();
    await h.tower.runners.report(a, receipt(c.attempt.id, c.attempt.fence, 'complete', { completion: completion() }));
    expect((await h.tower.repo.mission(h.workspaceId, m.id)).state).toBe('completed');
  });

  it('F8: resuming a paused packet keeps its live attempt instead of abandoning it', async () => {
    const h = await makeHarness();
    await h.tower.missions.create(h.owner, simpleMission());
    const a = await registerRunner(h, 'A');
    const c = (await h.tower.runners.claim(a))!;
    await h.tower.runners.report(a, receipt(c.attempt.id, c.attempt.fence, 'progress', { phase: 'build' }));
    const pid = c.attempt.packetId;
    await h.tower.runners.packetControl(h.owner, pid, 'pause');
    await h.tower.runners.packetControl(h.owner, pid, 'resume');
    const hb = await h.tower.runners.heartbeat(a, { attempts: [{ attemptId: c.attempt.id, fence: c.attempt.fence }] });
    expect(hb.directives[0]!.action).toBe('continue');
    expect((await h.tower.repo.packet(h.workspaceId, pid)).state).toBe('running');
    expect((await h.tower.repo.attempt(h.workspaceId, c.attempt.id)).control).toBeNull();
  });

  it('F9: maxUses holds under interleaved effects', async () => {
    const h = await makeHarness();
    await h.tower.policy.grant(h.owner, { action: 'notify.slack', resource: '*', grantee: 'runner', conditions: { maxUses: 1 } });
    await h.tower.missions.create(h.owner, simpleMission({ packets: [{ title: 'p1', goal: 'g' }, { title: 'p2', goal: 'g' }] }));
    const a = await registerRunner(h, 'A');
    const b = await registerRunner(h, 'B');
    const ca = (await h.tower.runners.claim(a))!;
    const cb = (await h.tower.runners.claim(b))!;
    const orig = h.db.all.bind(h.db);
    let fired = false;
    h.db.all = (async (sql: string, params?: SqlValue[]) => {
      const rows = await orig(sql, params);
      if (!fired && sql.includes("FROM policy_rules WHERE workspace_id = ? AND status = 'active'")) {
        // B has read the rules; A authorizes and commits a use before B commits.
        fired = true;
        await h.tower.runners.authorizeEffect(a, { attemptId: ca.attempt.id, fence: ca.attempt.fence, action: 'notify.slack', resource: 'x' });
      }
      return rows;
    }) as typeof h.db.all;
    await expect(h.tower.runners.authorizeEffect(b, { attemptId: cb.attempt.id, fence: cb.attempt.fence, action: 'notify.slack', resource: 'x' })).rejects.toMatchObject({ code: 'policy_denied' });
    expect(fired).toBe(true);
    expect((await h.tower.repo.rules(h.workspaceId, true))[0]!.uses).toBe(1);
  });

  it('F10: concurrent requests with one idempotency key run the command once', async () => {
    const h = await makeHarness();
    const orig = h.db.first.bind(h.db);
    h.db.first = (async (sql: string, params?: SqlValue[]) => {
      const r = await orig(sql, params);
      if (sql.includes('FROM idempotency')) await new Promise((res) => setTimeout(res, 20));
      return r;
    }) as typeof h.db.first;
    const results = await Promise.allSettled([h.tower.missions.create(h.owner, simpleMission({ start: false }), 'k1'), h.tower.missions.create(h.owner, simpleMission({ start: false }), 'k1')]);
    // Exactly one execution. The duplicate either replays the stored response or, if it
    // arrives while the first is still running, gets a retryable conflict.
    expect((await h.tower.repo.missions(h.workspaceId)).length).toBe(1);
    const ok = results.filter((r): r is PromiseFulfilledResult<Mission> => r.status === 'fulfilled');
    expect(new Set(ok.map((r) => r.value.id)).size).toBe(1);
    for (const r of results) if (r.status === 'rejected') expect(r.reason).toMatchObject({ code: 'conflict' });
    // Once finished, a retry with the same key replays the stored response.
    const replay = await h.tower.missions.create(h.owner, simpleMission({ start: false }), 'k1');
    expect(replay.id).toBe(ok[0]!.value.id);
  });
});
