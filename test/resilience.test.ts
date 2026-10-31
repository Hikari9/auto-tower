import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportBackup, restoreBackup } from '../src/service/admin.ts';
import { Tower } from '../src/service/tower.ts';
import { D1Driver, type D1Like, type D1StmtLike } from '../src/store/d1.ts';
import { migrate, type SqlValue } from '../src/store/sql.ts';
import { loadMigrations, NodeSqliteDriver } from '../src/store/sqlite-node.ts';
import { completion, makeHarness, receipt, registerRunner, simpleMission } from './harness.ts';

/** A D1-shaped shim over node:sqlite so the D1 driver's batch semantics are exercised. */
function fakeD1(db: NodeSqliteDriver): D1Like {
  const mk = (sql: string, params: unknown[] = []): D1StmtLike & { sql: string; params: unknown[] } => ({
    sql,
    params,
    bind: (...v: unknown[]) => mk(sql, v),
    all: async <T>() => ({ results: db.db.prepare(sql).all(...(params as SqlValue[])) as T[] }),
    first: async <T>() => (db.db.prepare(sql).get(...(params as SqlValue[])) as T) ?? null,
  });
  return {
    prepare: (sql) => mk(sql),
    batch: async (stmts) => {
      db.db.exec('BEGIN');
      try {
        for (const s of stmts as unknown as { sql: string; params: SqlValue[] }[]) db.db.prepare(s.sql).run(...s.params);
        db.db.exec('COMMIT');
      } catch (e) {
        db.db.exec('ROLLBACK');
        throw new Error(`D1_ERROR: ${(e as Error).message}`);
      }
      return [];
    },
    exec: async (sql) => db.db.exec(sql),
  };
}

describe('resilience', () => {
  it('survives a service restart: missions, policy version and audit history persist on disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tower-'));
    const path = join(dir, 'tower.db');
    try {
      const h = await makeHarness({ path });
      const m = await h.tower.missions.create(h.owner, simpleMission());
      await h.tower.policy.grant(h.owner, { action: 'deploy.preview', resource: '*', grantee: 'chief' });
      const before = await h.tower.repo.events(h.workspaceId, { afterSeq: 0, limit: 1000 });
      h.db.close();
      const db = new NodeSqliteDriver(path);
      await migrate(db, loadMigrations());
      const t2 = new Tower({ db, clock: h.clock.now });
      const owner = await t2.authenticate(h.ownerToken);
      expect((await t2.missions.get(owner, m.id)).mission.activity).toBe('waiting_runner');
      expect((await t2.policy.list(owner)).policyVersion).toBe(1);
      expect((await t2.repo.events(h.workspaceId, { afterSeq: 0, limit: 1000 })).map((e) => e.id)).toEqual(before.map((e) => e.id));
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('restore drill: a backup restores into a fresh database with identical state and working credentials', async () => {
    const h = await makeHarness();
    const m = await h.tower.missions.create(h.owner, simpleMission({ links: [{ url: 'https://github.com/acme/app/issues/1' }] }));
    const r = await registerRunner(h, 'one');
    const c = (await h.tower.runners.claim(r))!;
    await h.tower.runners.report(r, receipt(c.attempt.id, c.attempt.fence, 'complete', { completion: completion() }));
    await h.tower.policy.grant(h.owner, { action: 'x', resource: 'y', grantee: 'chief' });
    const backup = await h.tower.admin.exportBackup(h.owner);
    await expect(h.tower.admin.exportBackup(h.chief)).rejects.toMatchObject({ code: 'forbidden' });

    const fresh = new NodeSqliteDriver(':memory:');
    await migrate(fresh, loadMigrations());
    const counts = await restoreBackup(fresh, JSON.parse(JSON.stringify(backup)));
    expect(counts.missions).toBe(1);
    await expect(restoreBackup(fresh, backup)).rejects.toMatchObject({ code: 'conflict' });
    const t2 = new Tower({ db: fresh, clock: h.clock.now });
    const owner = await t2.authenticate(h.ownerToken);
    const restored = await t2.missions.get(owner, m.id);
    const original = await h.tower.missions.get(h.owner, m.id);
    expect(restored.mission).toEqual(original.mission);
    expect(restored.events.map((e) => e.id)).toEqual(original.events.map((e) => e.id));
    expect((await t2.policy.list(owner)).policyVersion).toBe(1);
    const again = await exportBackup(fresh, backup.exportedAt);
    // Everything but the target's own migration timestamps round-trips exactly.
    const { schema_migrations: _a, ...restoredTables } = again.tables;
    const { schema_migrations: _b, ...originalTables } = backup.tables;
    expect(restoredTables).toEqual(originalTables);
  });

  it('fails closed when storage is unavailable: no partial write, actionable error', async () => {
    const h = await makeHarness();
    const m = await h.tower.missions.create(h.owner, simpleMission({ start: false }));
    h.db.failNextBatch = new Error('D1_ERROR: exceeded free-tier rows written limit');
    await expect(h.tower.missions.start(h.owner, m.id)).rejects.toMatchObject({ code: 'unavailable' });
    expect((await h.tower.repo.mission(h.workspaceId, m.id)).state).toBe('draft');
    await h.tower.missions.start(h.owner, m.id);
    expect((await h.tower.repo.mission(h.workspaceId, m.id)).state).toBe('active');
  });

  it('runs the full flow on the D1 driver (atomic batch rollback on conflict)', async () => {
    const node = new NodeSqliteDriver(':memory:');
    await migrate(node, loadMigrations());
    const d1 = new D1Driver(fakeD1(node));
    const t = new Tower({ db: d1 });
    const boot = await t.admin.bootstrap({ workspaceName: 'w', ownerName: 'o' });
    const owner = await t.authenticate(boot.ownerToken);
    const m = await t.missions.create(owner, simpleMission({ start: false }));
    const tx1 = t.uow(owner);
    tx1.event({ stream: 'mission', id: m.id, expected: m.version, type: 'x' });
    tx1.run('UPDATE missions SET title = ? WHERE id = ?', 'changed', m.id);
    await tx1.commit(d1);
    const tx2 = t.uow(owner);
    tx2.run('UPDATE missions SET title = ? WHERE id = ?', 'lost', m.id);
    tx2.event({ stream: 'mission', id: m.id, expected: m.version, type: 'y' });
    await expect(tx2.commit(d1)).rejects.toMatchObject({ code: 'conflict' });
    expect((await t.repo.mission(boot.workspaceId, m.id)).title).toBe('changed');
  });

  it('sweeps are safe to repeat and never lose or falsely complete a mission', async () => {
    const h = await makeHarness();
    const m = await h.tower.missions.create(h.owner, simpleMission());
    for (let i = 0; i < 5; i++) {
      h.clock.advance(60_000);
      const s = await h.tower.scheduler.sweep();
      expect(s.errors).toEqual([]);
    }
    const cur = await h.tower.repo.mission(h.workspaceId, m.id);
    expect(cur.state).toBe('active');
    expect(cur.activity).toBe('waiting_runner');
    const health = await h.tower.admin.health(h.owner);
    expect(health.signals).toContain('ready work is waiting for an eligible runner');
    expect(health.cloudAi).toEqual({ 'cloud_ai.classifier': false, 'cloud_ai.hosted_runner': false });
  });

  it('keeps cloud AI off by default and refuses to enable it without provider, model, budget and credential', async () => {
    const h = await makeHarness();
    await expect(h.tower.admin.setFlag(h.owner, 'cloud_ai.classifier', { enabled: true })).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      h.tower.admin.setFlag(h.owner, 'cloud_ai.classifier', { enabled: true, provider: 'x', model: 'y', monthlyBudgetUsd: 1, credentialSecret: 'K', grantsAuthority: true }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await h.tower.admin.setFlag(h.owner, 'cloud_ai.classifier', { enabled: true, provider: 'x', model: 'y', monthlyBudgetUsd: 1, credentialSecret: 'K' });
    expect((await h.tower.admin.health(h.owner)).cloudAi['cloud_ai.classifier']).toBe(true);
  });

  it('rotating a credential invalidates the old token immediately', async () => {
    const h = await makeHarness();
    const { token } = await h.tower.admin.rotateToken(h.owner, h.chief.principal.id);
    await expect(h.tower.authenticate(h.chiefToken)).rejects.toMatchObject({ code: 'unauthenticated' });
    expect((await h.tower.authenticate(token)).principal.kind).toBe('chief');
  });
});
