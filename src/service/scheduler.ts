import { SPECS } from '../store/codec.ts';
import { movePacket } from './runners.ts';
import type { Tower } from './tower.ts';

export interface SweepReport {
  workspaces: number;
  leasesExpired: number;
  reassignable: number;
  recoveryDecisions: number;
  runnersOffline: number;
  missionsRefreshed: number;
  linksPolled: number;
  errors: string[];
}

/**
 * Deterministic scheduled sweep (Cron Trigger on Workers, interval timer on Node).
 * The database is the source of truth; the sweep only advances state that time
 * makes due: expired leases, offline runners, recovery deadlines, retries,
 * mission progress and provider polling.
 */
export class Scheduler {
  private readonly t: Tower;

  constructor(t: Tower) {
    this.t = t;
  }

  async sweep(): Promise<SweepReport> {
    const report: SweepReport = { workspaces: 0, leasesExpired: 0, reassignable: 0, recoveryDecisions: 0, runnersOffline: 0, missionsRefreshed: 0, linksPolled: 0, errors: [] };
    const workspaces = await this.t.db.all<{ id: string }>('SELECT id FROM workspaces');
    for (const { id } of workspaces) {
      report.workspaces++;
      for (const [name, step] of [
        ['leases', () => this.expireLeases(id, report)],
        ['recovery', () => this.advanceRecovery(id, report)],
        ['runners', () => this.markOffline(id, report)],
        ['missions', () => this.refreshMissions(id, report)],
        ['links', async () => void (report.linksPolled += await this.t.issues.pollDue(id))],
      ] as const) {
        try {
          await step();
        } catch (err) {
          // One failing step must not starve the others; it surfaces in Health.
          report.errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    await this.t.db
      .batch([
        {
          sql: 'INSERT INTO health (key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at',
          params: ['sweep', JSON.stringify(report), this.t.now()],
        },
      ])
      .catch(() => undefined);
    return report;
  }

  /** A lease that expired without a heartbeat makes the attempt lost and the packet recovering. */
  private async expireLeases(ws: string, report: SweepReport): Promise<void> {
    const now = this.t.now();
    for (const a of await this.t.repo.attemptsFor(ws, { states: ['leased', 'running'] })) {
      if (a.leaseExpiresAt > now) continue;
      await this.t.retrying(async () => {
        const cur = await this.t.repo.attempt(ws, a.id);
        if (!['leased', 'running'].includes(cur.state) || cur.leaseExpiresAt > this.t.now()) return;
        const p = await this.t.repo.packet(ws, cur.packetId);
        const tx = this.t.uow(this.t.systemActor(ws));
        tx.save('attempt', SPECS.attempt, { ...cur, state: 'lost' as const }, 'attempt.lost', { missionId: cur.missionId, payload: { leaseExpiresAt: cur.leaseExpiresAt, runnerId: cur.runnerId } });
        if (['leased', 'running', 'held'].includes(p.state) && p.currentAttemptId === cur.id) {
          movePacket(tx, p, p.state === 'held' ? 'held' : 'recovering', 'packet.recovering', {
            holdReason: p.state === 'held' ? p.holdReason : `runner ${cur.runnerId} stopped heartbeating; waiting for it to reconnect`,
            checkpoint: cur.checkpoint ?? p.checkpoint,
          });
        }
        await tx.commit(this.t.db);
        report.leasesExpired++;
      });
    }
  }

  /**
   * Recovering packets: a portable checkpoint (pushed branch, persisted artifact)
   * lets another runner take over with a new fence. Without one, Tower waits for
   * the original runner and, after the recovery window, asks the owner instead of
   * launching the same mutable job twice.
   */
  private async advanceRecovery(ws: string, report: SweepReport): Promise<void> {
    const now = Date.parse(this.t.now());
    for (const p of await this.t.repo.packetsByState(ws, ['recovering'])) {
      const a = p.currentAttemptId ? await this.t.repo.attempt(ws, p.currentAttemptId) : null;
      if (a && a.state !== 'lost') continue;
      const runner = a ? await this.t.repo.runner(ws, a.runnerId) : null;
      const checkpoint = a?.checkpoint ?? p.checkpoint;
      const lostFor = a ? now - Date.parse(a.leaseExpiresAt) : Infinity;
      if (checkpoint?.portable && (runner?.status !== 'online' || lostFor > this.t.config.leaseMs)) {
        await this.t.retrying(async () => {
          const cur = await this.t.repo.packet(ws, p.id);
          if (cur.state !== 'recovering') return;
          const tx = this.t.uow(this.t.systemActor(ws));
          movePacket(tx, cur, 'ready', 'packet.reassignable', { checkpoint, holdReason: null }, { resumeFrom: checkpoint });
          await tx.commit(this.t.db);
          report.reassignable++;
        });
        continue;
      }
      if (lostFor < this.t.config.recoveryMs) continue;
      await this.t.retrying(async () => {
        const cur = await this.t.repo.packet(ws, p.id);
        if (cur.state !== 'recovering') return;
        const tx = this.t.uow(this.t.systemActor(ws));
        const d = await this.t.decisions.raiseTx(tx, {
          missionId: cur.missionId,
          packetIds: [cur.id],
          category: 'recovery',
          urgency: 'normal',
          audience: 'human',
          question: `Runner ${runner?.name ?? a?.runnerId ?? 'unknown'} went offline holding "${cur.title}" with no portable checkpoint. Restart it from scratch on another runner?`,
          alternatives: [
            { id: 'approve', label: 'Restart elsewhere', consequence: 'Local unpushed work on the offline machine is abandoned and fenced.' },
            { id: 'decline', label: 'Keep waiting', consequence: 'The branch stays paused until the original runner reconnects.' },
          ],
          consequences: 'Other branches keep running either way.',
          requiredAuthority: { action: 'attempt.restart', resource: `packet:${cur.id}`, risk: cur.risk },
          affectedScope: cur.execScope,
          dedupeKey: `recovery|${cur.id}|${cur.currentAttemptId}`,
        });
        this.t.decisions.holdPacketsTx(tx, [cur], d.id, 'waiting for the owner: restart lost work elsewhere?');
        await tx.commit(this.t.db);
        report.recoveryDecisions++;
      });
    }
  }

  private async markOffline(ws: string, report: SweepReport): Promise<void> {
    const cutoff = new Date(this.t.clock().getTime() - this.t.config.runnerOfflineMs).toISOString();
    const res = await this.t.db.all<{ id: string }>("SELECT id FROM runners WHERE workspace_id = ? AND status IN ('online','draining') AND (last_seen_at IS NULL OR last_seen_at < ?)", [ws, cutoff]);
    if (!res.length) return;
    await this.t.db.batch(res.map((r) => ({ sql: "UPDATE runners SET status = 'offline' WHERE id = ?", params: [r.id] })));
    report.runnersOffline += res.length;
  }

  private async refreshMissions(ws: string, report: SweepReport): Promise<void> {
    for (const m of await this.t.repo.missions(ws, { states: ['active', 'verifying', 'reconciling'], limit: 500 })) {
      await this.t.missions.refresh(ws, m.id);
      report.missionsRefreshed++;
    }
  }
}
