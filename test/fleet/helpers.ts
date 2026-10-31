import { createApp } from '../../src/api/app.js';
import { type Core, createCore } from '../../src/core/index.js';
import type { CommandContext } from '../../src/core/service.js';
import type { Actor, MissionState } from '../../src/core/types.js';
import {
  createFleet,
  createPool,
  defaultFleetConfig,
  type Fleet,
  type FleetConfig,
  type VersionRange,
} from '../../src/fleet/index.js';
import type { SqlDatabase } from '../../src/storage/database.js';
import { FakeClock, mission } from '../core/helpers.js';
import {
  openTestDatabase,
  seedPrincipal,
  TEST_WORKSPACE,
} from '../helpers/tower.js';

export const VERSION = '1.2.3';
export const OTHER_VERSION = '1.4.0';
export const DIGEST = `sha256:${'a'.repeat(64)}`;
export const OTHER_DIGEST = `sha256:${'b'.repeat(64)}`;

export type Json = {
  status: number;
  // biome-ignore lint/suspicious/noExplicitAny: test responses are untyped JSON
  body: any;
};

export type Call = (
  token: string | undefined,
  method: string,
  path: string,
  body?: unknown,
) => Promise<Json>;

export interface RunnerClient {
  id: string;
  token: string;
  version: string;
  digest: string;
  call(method: string, path: string, body?: unknown): Promise<Json>;
  /** Polls for work, as the runner would. */
  claim(extra?: Record<string, unknown>): Promise<Json>;
  heartbeat(active?: unknown[], extra?: Record<string, unknown>): Promise<Json>;
  progress(leaseId: string, body: Record<string, unknown>): Promise<Json>;
  checkpoint(leaseId: string, body: Record<string, unknown>): Promise<Json>;
  receipt(leaseId: string, body: Record<string, unknown>): Promise<Json>;
  reconcile(leaseId: string, fence: number): Promise<Json>;
}

export interface PacketSpec {
  title?: string;
  scope?: string[];
  instructions?: string;
}

function callOver(app: ReturnType<typeof createApp>): Call {
  return async (token, method, path, rawBody) => {
    const body = method === 'GET' || method === 'HEAD' ? undefined : rawBody;
    const res = await app.request(path, {
      method,
      headers: {
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return {
      status: res.status,
      body: text === '' ? undefined : JSON.parse(text),
    };
  };
}

export interface FleetHarness {
  db: SqlDatabase;
  core: Core;
  fleet: Fleet;
  clock: FakeClock;
  config: FleetConfig;
  call: Call;
  owner: { token: string; actor: Actor };
  cos: { token: string; actor: Actor };
  setRange(range: VersionRange): void;
  ctx(extra?: Partial<CommandContext>): CommandContext;
  /** Another app over another connection to the same database file. */
  connect(db: SqlDatabase): { call: Call; core: Core; fleet: Fleet };
  enroll(options?: EnrollOptions): Promise<Json>;
  runner(
    options?: EnrollOptions & { capabilities?: string[] },
  ): Promise<RunnerClient>;
  mission(packets: PacketSpec[]): { id: string; packetIds: string[] };
  getMission(id: string): MissionState;
  tick(): void;
}

export interface EnrollOptions {
  name?: string;
  version?: string;
  buildDigest?: string;
  allowedScopes?: string[];
  maxConcurrent?: number;
  expiresInSeconds?: number;
}

export function createFleetHarness(
  options: { db?: SqlDatabase; config?: Partial<FleetConfig> } = {},
): FleetHarness {
  const db = options.db ?? openTestDatabase();
  const clock = new FakeClock();
  let range: VersionRange = { min: '1.0.0', max: '1.9.9' };
  const config: FleetConfig = {
    ...defaultFleetConfig(),
    ...options.config,
    supportedVersions: () => range,
  };
  const owner = seedPrincipal(db, { kind: 'human', name: 'owner' });
  const cos = seedPrincipal(db, { kind: 'chief_of_staff', name: 'cos' });

  function build(handle: SqlDatabase) {
    const core = createCore({
      db: handle,
      clock: clock.now,
      pool: createPool({ db: handle, now: clock.now, config }),
    });
    const fleet = createFleet({ db: handle, core, now: clock.now, config });
    const app = createApp({ db: handle, now: clock.now, core, fleet });
    return { core, fleet, call: callOver(app) };
  }
  const main = build(db);
  const ownerActor: Actor = { id: owner.principalId, kind: 'human' };

  const harness: FleetHarness = {
    db,
    ...main,
    clock,
    config,
    owner: { token: owner.token, actor: ownerActor },
    cos: {
      token: cos.token,
      actor: { id: cos.principalId, kind: 'chief_of_staff' },
    },
    setRange(next) {
      range = next;
    },
    ctx: (extra = {}) => ({
      workspaceId: TEST_WORKSPACE,
      actor: ownerActor,
      ...extra,
    }),
    connect: (handle) => build(handle),

    enroll: (opts = {}) =>
      main.call(owner.token, 'POST', '/runners/enrollments', {
        name: opts.name ?? 'runner',
        version: opts.version ?? VERSION,
        buildDigest: opts.buildDigest ?? DIGEST,
        allowedScopes: opts.allowedScopes ?? ['*'],
        maxConcurrent: opts.maxConcurrent ?? 2,
        ...(opts.expiresInSeconds === undefined
          ? {}
          : { expiresInSeconds: opts.expiresInSeconds }),
      }),

    async runner(opts = {}) {
      const enrolled = await harness.enroll(opts);
      if (enrolled.status !== 201) {
        throw new Error(`enroll failed: ${JSON.stringify(enrolled.body)}`);
      }
      const version = opts.version ?? VERSION;
      const digest = opts.buildDigest ?? DIGEST;
      const registered = await main.call(
        enrolled.body.enrollment.token,
        'POST',
        '/runners/register',
        { version, buildDigest: digest, capabilities: opts.capabilities ?? [] },
      );
      if (registered.status !== 201) {
        throw new Error(`register failed: ${JSON.stringify(registered.body)}`);
      }
      return clientFor(
        main.call,
        registered.body.runnerId,
        registered.body.token,
        version,
        digest,
      );
    },

    mission(packets) {
      const created = main.core.missions.createMission(
        harness.ctx(),
        mission(),
      );
      let state = created.mission;
      const step = (next: { mission: MissionState }) => {
        state = next.mission;
      };
      step(
        main.core.missions.transitionMission(
          harness.ctx(),
          state.id,
          state.version,
          'ready',
          null,
        ),
      );
      const packetIds: string[] = [];
      for (const spec of packets) {
        step(
          main.core.missions.addPacket(harness.ctx(), state.id, state.version, {
            title: spec.title ?? 'packet',
            instructions: spec.instructions ?? 'do the thing',
            scope: spec.scope ?? [],
            required: true,
            dependsOn: [],
          }),
        );
        const added = state.packets[state.packets.length - 1];
        if (added === undefined) {
          throw new Error('packet was not added');
        }
        packetIds.push(added.id);
        step(
          main.core.missions.authorizePacket(
            harness.ctx(),
            state.id,
            state.version,
            added.id,
            [],
          ),
        );
      }
      return { id: state.id, packetIds };
    },

    getMission(id) {
      const found = main.core.missions.getMission(TEST_WORKSPACE, id);
      if (found === undefined) {
        throw new Error('mission vanished');
      }
      return found;
    },

    tick() {
      main.core.scheduler.tick(TEST_WORKSPACE, ownerActor);
    },
  };
  return harness;
}

export function clientFor(
  call: Call,
  id: string,
  token: string,
  version = VERSION,
  digest = DIGEST,
): RunnerClient {
  const bind = { version, buildDigest: digest };
  return {
    id,
    token,
    version,
    digest,
    call: (method, path, body) => call(token, method, path, body),
    claim: (extra = {}) =>
      call(token, 'POST', '/runners/claims', { ...bind, ...extra }),
    heartbeat: (active = [], extra = {}) =>
      call(token, 'POST', '/runners/heartbeat', { ...bind, active, ...extra }),
    progress: (leaseId, body) =>
      call(token, 'POST', `/runners/leases/${leaseId}/progress`, body),
    checkpoint: (leaseId, body) =>
      call(token, 'POST', `/runners/leases/${leaseId}/checkpoints`, body),
    receipt: (leaseId, body) =>
      call(token, 'POST', `/runners/leases/${leaseId}/receipts`, body),
    reconcile: (leaseId, fence) =>
      call(token, 'POST', `/runners/leases/${leaseId}/reconcile`, {
        ...bind,
        fence,
        progressSeq: 0,
      }),
  };
}

/** Evidence a runner presents for a lease it holds. Extra properties on `a` are dropped. */
export function evidence(a: {
  leaseId: string;
  attemptId: string;
  fence: number;
  progressSeq?: number;
}) {
  return {
    leaseId: a.leaseId,
    attemptId: a.attemptId,
    fence: a.fence,
    progressSeq: a.progressSeq ?? 0,
  };
}

export function auditKinds(h: FleetHarness): string[] {
  return h.fleet
    .audit(TEST_WORKSPACE, { afterSeq: 0, limit: 500 })
    .map((r) => r.kind);
}
