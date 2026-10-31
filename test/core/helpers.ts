import {
  ensureWorkspace,
  type PrincipalKind,
} from '../../src/auth/principals.js';
import { type Core, createCore } from '../../src/core/index.js';
import type { CreateMissionInput } from '../../src/core/inputs.js';
import type { RunnerPool } from '../../src/core/scheduler.js';
import type { CommandContext } from '../../src/core/service.js';
import type { Actor, MissionState } from '../../src/core/types.js';
import type { SqlDatabase } from '../../src/storage/database.js';
import { openTestDatabase, TEST_WORKSPACE } from '../helpers/tower.js';

/** Inserts a principal with a fixed id, so two databases can be compared event for event. Reopening a file reuses it. */
export function seedFixedPrincipal(
  db: SqlDatabase,
  id: string,
  kind: PrincipalKind,
  workspaceId = TEST_WORKSPACE,
): Actor {
  ensureWorkspace(db, workspaceId, workspaceId);
  db.run(
    'INSERT OR IGNORE INTO principals (id, workspace_id, kind, name, created_at) VALUES (?, ?, ?, ?, ?)',
    [id, workspaceId, kind, id, '2026-01-01T00:00:00.000Z'],
  );
  return { id, kind };
}

/** Ids `prefix_1`, `prefix_2`, ... so repeated runs name the same entities. */
export function sequentialIds(): (prefix: string) => string {
  let n = 0;
  return (prefix) => {
    n += 1;
    return `${prefix}_${n}`;
  };
}

export class FakeClock {
  constructor(private ms = Date.parse('2026-03-01T00:00:00.000Z')) {}

  now = (): Date => new Date(this.ms);

  advance(ms: number): void {
    this.ms += ms;
  }
}

/** A runner pool the test controls. `online` runners take any packet, first come first served. */
export class FakePool implements RunnerPool {
  online: string[] = [];
  /** Every request the scheduler made, so tests can check what it asked. */
  requests: Array<Parameters<RunnerPool['findEligible']>[0]> = [];

  findEligible(
    request: Parameters<RunnerPool['findEligible']>[0],
  ): { runnerId: string } | undefined {
    this.requests.push(request);
    const runnerId = this.online[0];
    return runnerId === undefined ? undefined : { runnerId };
  }
}

export interface Harness {
  db: SqlDatabase;
  core: Core;
  clock: FakeClock;
  pool: FakePool;
  owner: Actor;
  cos: Actor;
  runner: Actor;
  ctx(actor?: Actor, extra?: Partial<CommandContext>): CommandContext;
}

export function createHarness(
  options: {
    db?: SqlDatabase;
    workspaceId?: string;
    maxEventsPerMission?: number;
  } = {},
): Harness {
  const db = options.db ?? openTestDatabase();
  const workspaceId = options.workspaceId ?? TEST_WORKSPACE;
  const owner = seedFixedPrincipal(db, 'prn_owner', 'human', workspaceId);
  const cos = seedFixedPrincipal(db, 'prn_cos', 'chief_of_staff', workspaceId);
  const runner = seedFixedPrincipal(db, 'prn_runner', 'runner', workspaceId);
  const clock = new FakeClock();
  const pool = new FakePool();
  const core = createCore({
    db,
    clock: clock.now,
    pool,
    newId: sequentialIds(),
    ...(options.maxEventsPerMission === undefined
      ? {}
      : { maxEventsPerMission: options.maxEventsPerMission }),
  });
  return {
    db,
    core,
    clock,
    pool,
    owner,
    cos,
    runner,
    ctx: (actor = owner, extra = {}) => ({ workspaceId, actor, ...extra }),
  };
}

export const MISSION_INPUT: CreateMissionInput = {
  title: 'Ship the thing',
  intent: 'Make the thing available to users',
  outcome: 'Users can use the thing',
  constraints: ['no downtime'],
  risk: 'medium',
  size: 'm',
  priority: 'normal',
  definitionOfDone: [],
  source: 'test',
  parentId: null,
  requiredForParent: true,
  links: [],
  policyRefs: [],
};

export function mission(
  overrides: Partial<CreateMissionInput> = {},
): CreateMissionInput {
  return { ...MISSION_INPUT, ...overrides };
}

export function packet(
  title: string,
  overrides: { dependsOn?: string[]; required?: boolean } = {},
) {
  return {
    title,
    instructions: '',
    scope: ['repo:app'],
    required: overrides.required ?? true,
    dependsOn: overrides.dependsOn ?? [],
  };
}

/** Test driver that tracks the mission's version so each call can pass the right expected version. */
export class MissionDriver {
  constructor(
    readonly h: Harness,
    public state: MissionState,
  ) {}

  static create(
    h: Harness,
    input: CreateMissionInput = mission(),
    actor?: Actor,
  ) {
    return new MissionDriver(
      h,
      h.core.missions.createMission(h.ctx(actor), input).mission,
    );
  }

  get id(): string {
    return this.state.id;
  }

  private take(result: { mission: MissionState }): MissionState {
    this.state = result.mission;
    return this.state;
  }

  go(
    to: Parameters<Harness['core']['missions']['transitionMission']>[3],
    actor?: Actor,
  ) {
    return this.take(
      this.h.core.missions.transitionMission(
        this.h.ctx(actor),
        this.id,
        this.state.version,
        to,
        null,
      ),
    );
  }

  addPacket(
    title: string,
    overrides: { dependsOn?: string[]; required?: boolean } = {},
  ) {
    const result = this.h.core.missions.addPacket(
      this.h.ctx(),
      this.id,
      this.state.version,
      packet(title, overrides),
    );
    this.take(result);
    const added = this.state.packets[this.state.packets.length - 1];
    if (added === undefined) {
      throw new Error('packet was not added');
    }
    return added.id;
  }

  authorize(packetId: string, actor?: Actor, policyRefs: string[] = []) {
    return this.take(
      this.h.core.missions.authorizePacket(
        this.h.ctx(actor),
        this.id,
        this.state.version,
        packetId,
        policyRefs,
      ),
    );
  }

  tick() {
    const result = this.h.core.scheduler.tick(
      this.state.workspaceId,
      this.h.owner,
    );
    this.refresh();
    return result;
  }

  refresh() {
    const current = this.h.core.missions.getMission(
      this.state.workspaceId,
      this.id,
    );
    if (current === undefined) {
      throw new Error('mission vanished');
    }
    this.state = current;
    return current;
  }

  /** Runner-side: start and report the packet's active attempt, as the dispatched runner. */
  runAttempt(packetId: string, outcome: 'succeeded' | 'failed' = 'succeeded') {
    this.refresh();
    const attemptId = this.state.packets.find(
      (p) => p.id === packetId,
    )?.activeAttemptId;
    if (attemptId === null || attemptId === undefined) {
      throw new Error(`packet ${packetId} has no active attempt`);
    }
    const { missions } = this.h.core;
    const runnerCtx = this.h.ctx(this.h.runner);
    this.take(
      missions.startAttempt(runnerCtx, this.id, this.state.version, attemptId),
    );
    return this.take(
      missions.reportAttempt(
        runnerCtx,
        this.id,
        this.state.version,
        attemptId,
        outcome,
        'done',
      ),
    );
  }

  verifyPacket(packetId: string, actor?: Actor) {
    return this.take(
      this.h.core.missions.verifyPacket(
        this.h.ctx(actor),
        this.id,
        this.state.version,
        packetId,
        ['ev:packet'],
      ),
    );
  }

  verifyOutcome(actor?: Actor) {
    return this.take(
      this.h.core.missions.verifyOutcome(
        this.h.ctx(actor),
        this.id,
        this.state.version,
        ['ev:outcome'],
      ),
    );
  }

  /** Drives a mission with no packets to `verifying` and records outcome evidence. */
  toVerifying() {
    this.go('ready');
    this.go('verifying');
    return this.state;
  }
}
