import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureWorkspace } from '../../src/auth/principals.js';
import {
  healthReport,
  runSweep,
  SWEEP_FAILED,
  startSweepInterval,
} from '../../src/ops/index.js';
import { createFleetHarness } from '../fleet/helpers.js';
import { openTestDatabase, TEST_WORKSPACE } from '../helpers/tower.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('the scheduled sweep', () => {
  it('dispatches ready work with no runner poll at all', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    await runner.claim(); // The runner is known and live, then it stops polling.
    const { id } = h.mission([{ scope: ['repo:app'] }]);
    expect(h.getMission(id).attempts).toEqual([]);

    const result = runSweep(h.db, h.fleet);
    expect(result).toEqual({ workspaces: 1, failed: [] });
    const attempts = h.getMission(id).attempts;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.runnerId).toBe(runner.id);
    expect(attempts[0]?.status).toBe('leased');
  });

  it('expires and recovers a lease whose runner went quiet, with no poll to notice', async () => {
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
    h.clock.advance(h.config.leaseTtlMs + 1000);
    runSweep(h.db, h.fleet);
    expect(
      h.db.get<{ status: string }>('SELECT status FROM runner_leases')?.status,
    ).toBe('recovering');
  });

  it('does not dispatch for a halted workspace, and still expires its leases', async () => {
    const h = createFleetHarness();
    const runner = await h.runner();
    await runner.claim();
    h.mission([{ scope: ['repo:app'] }]);
    h.tick();
    const lease = (await runner.claim()).body.assignments[0];
    await runner.heartbeat([
      {
        leaseId: lease.leaseId,
        attemptId: lease.attemptId,
        fence: lease.fence,
        progressSeq: 0,
      },
    ]);
    // Work added after the halt must not be dispatched.
    h.db.run(
      "INSERT INTO ops_halt (workspace_id, halted, reason, changed_by, changed_at) VALUES (?, 1, NULL, ?, '2026-03-01T00:00:00Z')",
      [TEST_WORKSPACE, h.owner.actor.id],
    );
    const { id: later } = h.mission([{ scope: ['repo:later'] }]);
    h.clock.advance(h.config.leaseTtlMs + 1000);
    runSweep(h.db, h.fleet);
    // The sweep half ran: the lease the runner stopped renewing moved to recovery.
    expect(
      h.db.get<{ status: string }>(
        'SELECT status FROM runner_leases WHERE id = ?',
        [lease.leaseId],
      )?.status,
    ).toBe('recovering');
    // The scheduling half did not: the new work has no attempt and did not move.
    expect(h.getMission(later).attempts).toEqual([]);
    expect(h.getMission(later).packets[0]?.status).toBe('pending');
  });

  it('keeps going when one workspace fails, and reports it as a health signal until a clean sweep', () => {
    const db = openTestDatabase();
    ensureWorkspace(db, 'ws_a', 'a');
    ensureWorkspace(db, 'ws_b', 'b');
    ensureWorkspace(db, 'ws_c', 'c');
    const ticked: string[] = [];
    let broken = true;
    const fleet = {
      tick(workspaceId: string) {
        if (workspaceId === 'ws_b' && broken) {
          throw new Error('disk on fire');
        }
        ticked.push(workspaceId);
      },
    };
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const first = runSweep(db, fleet);
    expect(first).toEqual({ workspaces: 3, failed: ['ws_b'] });
    expect(ticked).toEqual(['ws_a', 'ws_c']);
    // Only the error's name is logged, never its message.
    expect(JSON.stringify(quiet.mock.calls)).not.toContain('disk on fire');
    quiet.mockRestore();
    const signal = healthReport(db, 'ws_a').signals.find(
      (s) => s.code === SWEEP_FAILED,
    );
    expect(signal).toMatchObject({ severity: 'warning' });
    expect(signal?.action).toMatch(/server log/);

    broken = false;
    runSweep(db, fleet);
    expect(healthReport(db, 'ws_a').signals).toEqual([]);
  });
});

describe('a sweep that cannot even list workspaces', () => {
  it('does not throw into the timer: it logs the error name and raises the signal', () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = openTestDatabase();
    const broken = {
      ...db,
      all: () => {
        throw Object.assign(new Error('SECRET page 7 is corrupt'), {
          name: 'SqliteError',
        });
      },
    } as typeof db;
    const result = runSweep(broken, { tick: vi.fn() });
    expect(result).toEqual({ workspaces: 0, failed: ['*'] });
    expect(JSON.stringify(quiet.mock.calls)).not.toContain('SECRET');
    // Signals belong to the handle the sweep ran on. healthReport reads a healthy `get`.
    expect(healthReport(broken, 'ws_a').signals.map((s) => s.code)).toEqual([
      SWEEP_FAILED,
    ]);
    quiet.mockRestore();
  });

  it('keeps the interval running after one failed tick', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = openTestDatabase();
    let calls = 0;
    const broken = {
      ...db,
      all: () => {
        calls += 1;
        throw new Error('busy');
      },
    } as typeof db;
    const handle = startSweepInterval(broken, { tick: vi.fn() }, 1000);
    expect(() => vi.advanceTimersByTime(3500)).not.toThrow();
    expect(calls).toBe(3);
    handle.stop();
  });
});

describe('the sweep interval', () => {
  it('ticks on a timer until stopped, and does not keep the process alive', () => {
    vi.useFakeTimers();
    const db = openTestDatabase();
    ensureWorkspace(db, 'ws_a', 'a');
    const tick = vi.fn();
    const handle = startSweepInterval(db, { tick }, 1000);
    expect(tick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(3500);
    expect(tick).toHaveBeenCalledTimes(3);
    handle.stop();
    vi.advanceTimersByTime(5000);
    expect(tick).toHaveBeenCalledTimes(3);
  });

  it('uses an unref-ed timer so a server can exit', () => {
    const db = openTestDatabase();
    const spy = vi.spyOn(globalThis, 'setInterval');
    const handle = startSweepInterval(db, { tick() {} }, 60_000);
    const timer = spy.mock.results[0]?.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    handle.stop();
    spy.mockRestore();
  });

  it('skips a tick that arrives while the last sweep is still running', () => {
    vi.useFakeTimers();
    const db = openTestDatabase();
    ensureWorkspace(db, 'ws_a', 'a');
    let inside = 0;
    let peak = 0;
    const handle = startSweepInterval(
      db,
      {
        tick() {
          inside += 1;
          peak = Math.max(peak, inside);
          // A tick fired from inside the sweep, as a late timer would be.
          vi.advanceTimersByTime(1000);
          inside -= 1;
        },
      },
      1000,
    );
    vi.advanceTimersByTime(1000);
    expect(peak).toBe(1);
    handle.stop();
  });
});
