import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { officeRunnerEngine } from '../../src/adapters/office/engine.js';
import {
  exportBackup,
  readBackup,
  restoreBackup,
  storeFingerprint,
} from '../../src/ops/index.js';
import { TowerRunner } from '../../src/runner/runner.js';
import { createMemoryStateStore } from '../../src/runner/state.js';
import type { Transport } from '../../src/runner/transport.js';
import { applyMigrations } from '../../src/storage/migrate.js';
import {
  defaultMigrationsDir,
  readMigrationFiles,
} from '../../src/storage/migration-files.js';
import { openSqliteDatabase } from '../../src/storage/sqlite.js';
import { FakeOfficeEngine, FakeWorld } from '../adapters/office/fake-engine.js';
import { TEST_WORKSPACE } from '../helpers/tower.js';
import { ISSUE_URL } from '../issues/helpers.js';
import { key } from '../mcp/helpers.js';
import {
  createWorld,
  WORLD_DIGEST,
  WORLD_VERSION,
  type World,
} from './world.js';

export interface ScenarioReport {
  missionId: string;
  steps: string[];
  backupPath: string;
  restoredPath: string;
  fingerprint: string;
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`smoke check failed: ${message}`);
  }
}

function transportOver(world: World): Transport {
  return ({ method, path, body, token }) =>
    world.call(token, method, path, body);
}

async function enrollRunner(
  world: World,
  engine: ReturnType<typeof officeRunnerEngine>,
): Promise<TowerRunner> {
  const enrolled = await world.call(
    world.principals.owner.token,
    'POST',
    '/runners/enrollments',
    {
      name: 'smoke-runner',
      version: WORLD_VERSION,
      buildDigest: WORLD_DIGEST,
      allowedScopes: ['*'],
      maxConcurrent: 1,
    },
  );
  expect(enrolled.status === 201, `enrollment answered ${enrolled.status}`);
  const runner = new TowerRunner({
    transport: transportOver(world),
    engine,
    store: createMemoryStateStore(),
    binding: { version: WORLD_VERSION, buildDigest: WORLD_DIGEST },
  });
  await runner.register(enrolled.body.enrollment.token);
  return runner;
}

/**
 * Creates a mission over MCP, runs two fake runners, takes a decision through the inbox, reconciles
 * a required issue on a fake GitHub, completes the mission, then restores a backup into a fresh
 * database and reads everything back. No network and no paid service: every provider is a fake.
 */
export async function runScenario(
  log: (line: string) => void = () => {},
): Promise<ScenarioReport> {
  const steps: string[] = [];
  const step = (line: string) => {
    steps.push(line);
    log(line);
  };
  const world = createWorld();
  try {
    world.github.add(ISSUE_URL);
    world.issues.setSyncConfig(world.ownerCtx(), {
      provider: 'github',
      repo: 'acme/web',
      mode: 'observe',
    });
    const owner = await world.mcp(world.principals.owner.token);
    const cos = await world.mcp(world.principals.cos.token);

    // 1. A mission over MCP, with a required issue.
    const created = await owner.ok('create_mission', {
      title: 'Smoke mission',
      intent: 'Prove the control plane end to end',
      outcome: 'Every check passes',
      risk: 'medium',
      links: [{ url: ISSUE_URL, classification: 'required', title: null }],
      idempotencyKey: key('create'),
    });
    const missionId = created.mission.id as string;
    step(`created mission ${missionId} over MCP`);

    const { missions } = world.core;
    const ctx = world.ownerCtx();
    let state = missions.transitionMission(
      ctx,
      missionId,
      created.mission.version,
      'ready',
      null,
    ).mission;
    const packetIds: string[] = [];
    for (const scope of ['repo:a', 'repo:b']) {
      state = missions.addPacket(ctx, missionId, state.version, {
        title: `Work on ${scope}`,
        instructions: 'Do the work',
        scope: [scope],
        required: true,
        dependsOn: [],
      }).mission;
      packetIds.push(state.packets[state.packets.length - 1]?.id ?? '');
    }
    // The first packet is authorized by the owner directly.
    state = missions.authorizePacket(
      ctx,
      missionId,
      state.version,
      packetIds[0] ?? '',
      [],
    ).mission;

    // 2. The second goes through the Decision Inbox: the chief of staff asks, the person answers.
    const asked = await cos.ok('request_expansion', {
      missionId,
      packetId: packetIds[1],
      action: 'work.execute',
      resource: 'repo:b',
      scope: 'repo:b',
      risk: 'medium',
      question: 'May the second packet run against repo:b?',
      confirm: true,
      idempotencyKey: key('expand'),
    });
    expect(
      asked.outcome === 'decision_required',
      'expansion became a decision',
    );
    const open = (await owner.ok('list_decisions', {})).decisions as Array<{
      id: string;
    }>;
    expect(open.length === 1, 'one decision is open');
    await owner.ok('answer_decision', {
      decisionId: open[0]?.id,
      version: 1,
      choice: 'approve',
      note: 'ok',
      confirm: true,
      idempotencyKey: key('answer'),
    });
    expect(
      world.core.missions
        .getMission(TEST_WORKSPACE, missionId)
        ?.packets.every((p) => p.authorization !== null),
      'the approval authorized the second packet',
    );
    step('answered the decision through the inbox');

    // 3. Two runners, one packet each.
    const fakeWorld = new FakeWorld();
    const engine = () =>
      officeRunnerEngine(
        new FakeOfficeEngine(fakeWorld, { steps: 2, reviewer: 'reviewer-x' }),
      );
    const first = await enrollRunner(world, engine());
    const second = await enrollRunner(world, engine());
    const a = await first.pollOnce();
    const b = await second.pollOnce();
    expect(
      a.started.length === 1 && b.started.length === 1,
      'each runner took one packet',
    );
    await first.drain();
    await second.drain();
    state = world.core.missions.getMission(TEST_WORKSPACE, missionId) ?? state;
    expect(
      state.packets.every((p) => p.status === 'reported'),
      'both packets are reported',
    );
    step('two fake runners completed one packet each');

    // 4. Verification is the person's, never the runner's.
    for (const packetId of packetIds) {
      const current =
        world.core.missions.getMission(TEST_WORKSPACE, missionId) ?? state;
      missions.verifyPacket(ctx, missionId, current.version, packetId, [
        'evidence:smoke',
      ]);
    }
    world.core.scheduler.tick(TEST_WORKSPACE, world.principals.owner.actor);
    state = world.core.missions.getMission(TEST_WORKSPACE, missionId) ?? state;
    expect(
      state.state === 'verifying',
      `mission is verifying, not ${state.state}`,
    );
    missions.verifyOutcome(ctx, missionId, state.version, ['evidence:outcome']);

    // 5. Completion is blocked until the provider says the issue is closed.
    const early = await owner.call('close_mission', {
      missionId,
      expectedVersion: world.core.missions.getMission(TEST_WORKSPACE, missionId)
        ?.version,
      outcome: 'completed',
      confirm: true,
      idempotencyKey: key('early'),
    });
    expect(
      early.isError,
      'completion is refused while the required issue is open',
    );
    world.github.issue(ISSUE_URL).state = 'closed';
    const report = await owner.ok('request_reconciliation', {
      missionId,
      confirm: true,
      idempotencyKey: key('reconcile'),
    });
    expect(
      report.report.satisfied === true,
      'reconciliation read the issue closed',
    );
    const done = await owner.ok('close_mission', {
      missionId,
      expectedVersion: world.core.missions.getMission(TEST_WORKSPACE, missionId)
        ?.version,
      outcome: 'completed',
      confirm: true,
      idempotencyKey: key('complete'),
    });
    expect(done.mission.state === 'completed', 'the mission completed');
    step('reconciled the required issue and completed the mission');

    // 6. Back up, restore into a fresh database, restart on it, and read it all again.
    const before = storeFingerprint(world.db);
    const backup = exportBackup(world.db, { now: world.clock.now() });
    const backupPath = join(world.dir, 'backup.json');
    writeFileSync(backupPath, JSON.stringify(backup), { mode: 0o600 });
    chmodSync(backupPath, 0o600);
    const restoredPath = join(world.dir, 'restored.sqlite');
    const target = openSqliteDatabase(restoredPath);
    restoreBackup(
      target,
      readBackup(readFileSync(backupPath, 'utf8')),
      readMigrationFiles(defaultMigrationsDir()),
    );
    target.close();
    const principals = world.principals;
    world.close();

    const restored = createWorld({
      dbPath: restoredPath,
      migrated: true,
      existing: { owner: principals.owner.id, cos: principals.cos.id },
    });
    try {
      expect(
        storeFingerprint(restored.db).digest === before.digest,
        'the restored store holds the same state',
      );
      const again = await restored.mcp(restored.principals.owner.token);
      const read = await again.ok('read_mission', { missionId });
      expect(
        read.mission.state === 'completed',
        'the restored mission is completed',
      );
      expect(
        read.mission.packets.every(
          (p: { status: string }) => p.status === 'verified',
        ),
        'the restored packets are verified',
      );
      const evidence = await again.ok('inspect_evidence', { missionId });
      expect(
        evidence.issueLinks[0]?.verifiedClosed === true,
        'the restored issue link is verified closed',
      );
      step('restored from backup and read the mission back unchanged');
      return {
        missionId,
        steps,
        backupPath,
        restoredPath,
        fingerprint: before.digest,
      };
    } finally {
      restored.close();
    }
  } finally {
    try {
      world.close();
    } catch {
      // Already closed above.
    }
  }
}
