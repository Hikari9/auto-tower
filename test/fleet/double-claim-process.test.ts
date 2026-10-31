import { type ChildProcess, fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { openSqliteDatabase } from '../../src/storage/sqlite.js';
import {
  openTestDatabase,
  TEST_WORKSPACE,
  tempDbPath,
} from '../helpers/tower.js';
import { createFleetHarness, DIGEST, VERSION } from './helpers.js';

const WORKER = fileURLToPath(new URL('./claim-worker.ts', import.meta.url));

interface Outcome {
  ok: boolean;
  assignments?: string[];
  withheld?: string[];
  name?: string;
  message?: string;
}

/** Starts a claiming process, waits until it has its own connection open, and returns a trigger. */
function spawnClaimer(job: Record<string, unknown>) {
  const child: ChildProcess = fork(WORKER, [], {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const ready = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.on('message', (m) => m === 'ready' && resolve());
    child.once(
      'exit',
      (code) => code !== 0 && reject(new Error(`claimer exited ${code}`)),
    );
  });
  const done = new Promise<Outcome>((resolve, reject) => {
    child.on('message', (m) => {
      if (typeof m === 'object' && m !== null) {
        resolve(m as Outcome);
      }
    });
    child.once(
      'exit',
      (code) => code !== 0 && reject(new Error(`claimer exited ${code}`)),
    );
  });
  child.send(job);
  return { ready, done, go: () => child.send('go') };
}

describe('two claimers in separate processes, each with its own connection to one database file', () => {
  it('grants exactly one lease on a contested scope and hands the other claimer a backoff', async () => {
    const path = tempDbPath();
    const h = createFleetHarness({ db: openTestDatabase(path) });
    const a = await h.runner({ name: 'a' });
    const b = await h.runner({ name: 'b' });
    await a.claim();
    await b.claim();
    const { id } = h.mission([
      { scope: ['repo:app'] },
      { scope: ['repo:app'] },
    ]);
    h.tick();
    expect(h.getMission(id).attempts).toHaveLength(2);

    const tokenOf = (principalId: string) =>
      h.db.get<{ id: string }>(
        'SELECT id FROM api_tokens WHERE principal_id = ? AND revoked_at IS NULL',
        [principalId],
      )?.id ?? '';
    const job = (runnerId: string) => ({
      dbPath: path,
      nowMs: h.clock.now().getTime(),
      workspaceId: TEST_WORKSPACE,
      caller: {
        workspaceId: TEST_WORKSPACE,
        principalId: runnerId,
        tokenId: tokenOf(runnerId),
      },
      version: VERSION,
      buildDigest: DIGEST,
    });
    const first = spawnClaimer(job(a.id));
    const second = spawnClaimer(job(b.id));
    await Promise.all([first.ready, second.ready]);
    first.go();
    second.go();
    const outcomes = await Promise.all([first.done, second.done]);

    // Neither process crashed, and neither saw a database or constraint error.
    expect(outcomes.map((o) => o.ok)).toEqual([true, true]);
    const granted = outcomes.flatMap((o) => o.assignments ?? []);
    expect(granted).toHaveLength(1);
    const loser = outcomes.find((o) => (o.assignments ?? []).length === 0);
    expect(loser?.withheld).toEqual([
      'another runner holds the execution scope',
    ]);

    const live = h.db.all<{ id: string; runner_id: string }>(
      "SELECT id, runner_id FROM runner_leases WHERE status IN ('held','recovering')",
    );
    expect(live).toHaveLength(1);
    expect(live[0]?.id).toBe(granted[0]);
    // The database file is consistent from a third connection.
    const third = openSqliteDatabase(path);
    expect(third.all('PRAGMA integrity_check')).toEqual([
      { integrity_check: 'ok' },
    ]);
    third.close();
  }, 30_000);
});
