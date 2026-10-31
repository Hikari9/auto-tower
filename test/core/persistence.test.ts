import { describe, expect, it } from 'vitest';
import { createEventLog } from '../../src/events/event-log.js';
import {
  openTestDatabase,
  TEST_WORKSPACE,
  tempDbPath,
} from '../helpers/tower.js';
import { createHarness, MissionDriver, mission } from './helpers.js';

describe('restart', () => {
  it('keeps missions, packets, attempts and history across a reopened SQLite file', () => {
    const path = tempDbPath();
    const first = createHarness({ db: openTestDatabase(path) });
    first.pool.online = ['prn_runner'];
    const m = MissionDriver.create(
      first,
      mission({ title: 'Survives restart' }),
    );
    m.go('ready');
    const a = m.addPacket('A');
    const b = m.addPacket('B', { dependsOn: [a] });
    m.authorize(a);
    m.authorize(b);
    m.tick();
    m.runAttempt(a);
    m.verifyPacket(a);
    m.tick();
    const before = first.core.missions.getMission(TEST_WORKSPACE, m.id);
    const activityBefore = first.core.missions.activity(TEST_WORKSPACE, m.id, {
      afterVersion: 0,
      limit: 200,
    });
    const searchBefore = first.core.missions.search(TEST_WORKSPACE, {
      limit: 10,
      offset: 0,
    });
    first.db.close();

    const second = createHarness({ db: openTestDatabase(path) });

    expect(second.core.missions.getMission(TEST_WORKSPACE, m.id)).toEqual(
      before,
    );
    expect(second.core.missions.replayMission(TEST_WORKSPACE, m.id)).toEqual(
      before,
    );
    expect(
      second.core.missions.activity(TEST_WORKSPACE, m.id, {
        afterVersion: 0,
        limit: 200,
      }),
    ).toEqual(activityBefore);
    expect(
      second.core.missions.search(TEST_WORKSPACE, { limit: 10, offset: 0 }),
    ).toEqual(searchBefore);
    expect(before?.packets.map((p) => p.status)).toEqual([
      'verified',
      'leased',
    ]);
    expect(
      second.db.all('SELECT status FROM work_packets ORDER BY position'),
    ).toEqual([{ status: 'verified' }, { status: 'leased' }]);
  });

  it('carries on from the stored version: new commands append, stale ones are refused', () => {
    const path = tempDbPath();
    const first = createHarness({ db: openTestDatabase(path) });
    const m = MissionDriver.create(first);
    m.go('ready');
    first.db.close();

    const second = createHarness({ db: openTestDatabase(path) });
    expect(() =>
      second.core.missions.updateMission(second.ctx(), m.id, 1, {
        title: 'stale',
      }),
    ).toThrow(/expected 1/);
    const updated = second.core.missions.updateMission(second.ctx(), m.id, 2, {
      title: 'after restart',
    });

    expect(updated.mission).toMatchObject({
      version: 3,
      title: 'after restart',
      state: 'ready',
    });
    expect(
      createEventLog(second.db).readStream(TEST_WORKSPACE, `mission:${m.id}`),
    ).toHaveLength(3);
  });

  it('keeps idempotent replays working after a restart', () => {
    const path = tempDbPath();
    const first = createHarness({ db: openTestDatabase(path) });
    const created = first.core.missions.createMission(
      first.ctx(first.owner, { idempotencyKey: 'create-once' }),
      mission(),
    );
    first.db.close();

    const second = createHarness({ db: openTestDatabase(path) });
    const repeat = second.core.missions.createMission(
      second.ctx(second.owner, { idempotencyKey: 'create-once' }),
      mission(),
    );

    expect(repeat.replayed).toBe(true);
    expect(repeat.mission).toEqual(created.mission);
    expect(
      second.core.missions.search(TEST_WORKSPACE, { limit: 10, offset: 0 })
        .total,
    ).toBe(1);
  });

  it('lets a second connection to the same file see and extend a mission', () => {
    const path = tempDbPath();
    const one = createHarness({ db: openTestDatabase(path) });
    const two = createHarness({ db: openTestDatabase(path) });
    const m = MissionDriver.create(one);

    expect(two.core.missions.getMission(TEST_WORKSPACE, m.id)).toEqual(m.state);
    two.core.missions.updateMission(two.ctx(), m.id, 1, {
      title: 'from connection two',
    });

    expect(one.core.missions.getMission(TEST_WORKSPACE, m.id)?.title).toBe(
      'from connection two',
    );
    expect(() =>
      one.core.missions.updateMission(one.ctx(), m.id, 1, { title: 'stale' }),
    ).toThrow(/expected 1/);
  });
});
