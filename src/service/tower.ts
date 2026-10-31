import { newId as defaultNewId, sha256Hex } from '../domain/crypto.ts';
import { fail, TowerError } from '../domain/errors.ts';
import type { Actor, Principal } from '../domain/types.ts';
import { Repo } from '../store/repo.ts';
import type { SqlDriver } from '../store/sql.ts';
import { UnitOfWork } from '../store/uow.ts';
import { IssueProviderRegistry } from '../adapters/issues/registry.ts';
import { AdminService } from './admin.ts';
import { DecisionService } from './decisions.ts';
import { IssueService } from './issues.ts';
import { MissionService } from './missions.ts';
import { PolicyService } from './policy.ts';
import { RunnerService } from './runners.ts';
import { Scheduler } from './scheduler.ts';

export interface TowerConfig {
  /** Lease length granted on claim and renewed by heartbeat. */
  leaseMs: number;
  /** How long a lost non-portable attempt waits for its runner before a human decision is raised. */
  recoveryMs: number;
  /** A runner not seen for this long is shown offline. */
  runnerOfflineMs: number;
  /** Similar human approvals before Tower proposes a standing rule. */
  proposalThreshold: number;
  /** Minimum interval between provider polls of one link. */
  linkPollMs: number;
  /** Provider failures before a reconciling mission needs attention. */
  reconcileFailureLimit: number;
}

/** Marker stored while a keyed request is running. */
const PENDING = '__auto_tower_pending__';

export const DEFAULT_CONFIG: TowerConfig = {
  leaseMs: 90_000,
  recoveryMs: 30 * 60_000,
  runnerOfflineMs: 120_000,
  proposalThreshold: 3,
  linkPollMs: 10 * 60_000,
  reconcileFailureLimit: 3,
};

export interface TowerDeps {
  db: SqlDriver;
  clock?: () => Date;
  newId?: () => string;
  config?: Partial<TowerConfig>;
  providers?: IssueProviderRegistry;
}

/**
 * Tower Core: the single backend behind the HTTP API, MCP endpoint, dashboard
 * and scheduler. Hosting-agnostic: it only needs a SqlDriver and a clock.
 */
export class Tower {
  readonly db: SqlDriver;
  readonly repo: Repo;
  readonly clock: () => Date;
  readonly newId: () => string;
  readonly config: TowerConfig;
  readonly providers: IssueProviderRegistry;

  readonly missions: MissionService;
  readonly runners: RunnerService;
  readonly decisions: DecisionService;
  readonly policy: PolicyService;
  readonly issues: IssueService;
  readonly admin: AdminService;
  readonly scheduler: Scheduler;

  constructor(deps: TowerDeps) {
    this.db = deps.db;
    this.repo = new Repo(deps.db);
    this.clock = deps.clock ?? (() => new Date());
    this.newId = deps.newId ?? defaultNewId;
    this.config = { ...DEFAULT_CONFIG, ...deps.config };
    this.providers = deps.providers ?? new IssueProviderRegistry();
    this.missions = new MissionService(this);
    this.runners = new RunnerService(this);
    this.decisions = new DecisionService(this);
    this.policy = new PolicyService(this);
    this.issues = new IssueService(this);
    this.admin = new AdminService(this);
    this.scheduler = new Scheduler(this);
  }

  now(): string {
    return this.clock().toISOString();
  }

  later(ms: number): string {
    return new Date(this.clock().getTime() + ms).toISOString();
  }

  id(prefix: string): string {
    return `${prefix}_${this.newId()}`;
  }

  uow(actor: Actor): UnitOfWork {
    return new UnitOfWork(actor, this.now(), this.newId);
  }

  /** The workspace's internal system principal, used by the scheduler and webhooks. */
  systemActor(workspaceId: string, correlationId = `sys_${this.newId()}`): Actor {
    const principal: Principal = { id: `system:${workspaceId}`, workspaceId, kind: 'system', name: 'Tower scheduler', scopes: [], status: 'active' };
    return { principal, correlationId };
  }

  async authenticate(token: string | null | undefined, correlationId?: string): Promise<Actor> {
    if (!token) return fail('unauthenticated', 'missing bearer token');
    const p = await this.repo.principalByTokenHash(await sha256Hex(token));
    if (!p || p.status !== 'active') return fail('unauthenticated', 'invalid or revoked token');
    return { principal: p, correlationId: correlationId ?? `req_${this.newId()}` };
  }

  /**
   * Run a mutating command at most once per (principal, key). A retry with the
   * same key returns the stored response; reusing a key for a different request fails.
   */
  async idempotent<T>(actor: Actor, key: string | undefined, request: unknown, fn: () => Promise<T>): Promise<T> {
    if (!key) return fn();
    const ws = actor.principal.workspaceId;
    const pid = actor.principal.id;
    const hash = await sha256Hex(JSON.stringify(request ?? null));
    const replay = (prior: { requestHash: string; response: unknown }): T => {
      if (prior.requestHash !== hash) fail('idempotency_mismatch', 'idempotency key reused for a different request');
      if (prior.response === PENDING) fail('conflict', 'a request with this idempotency key is still in progress; retry shortly');
      return prior.response as T;
    };
    const prior = await this.repo.idempotent(ws, pid, key);
    if (prior) return replay(prior);
    // Reserve the key first so a concurrent duplicate cannot run the command too.
    try {
      await this.db.batch([
        { sql: 'INSERT INTO idempotency (workspace_id, principal_id, key, request_hash, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?)', params: [ws, pid, key, hash, JSON.stringify(PENDING), this.now()] },
      ]);
    } catch (err) {
      if (!(err instanceof TowerError && err.code === 'conflict')) throw err;
      const raced = await this.repo.idempotent(ws, pid, key);
      if (raced) return replay(raced);
      throw err;
    }
    let result: T;
    try {
      result = await fn();
    } catch (err) {
      // Failed commands leave no effect, so release the key for a genuine retry.
      await this.db.batch([{ sql: 'DELETE FROM idempotency WHERE workspace_id = ? AND principal_id = ? AND key = ?', params: [ws, pid, key] }]).catch(() => undefined);
      throw err;
    }
    await this.db.batch([
      { sql: 'UPDATE idempotency SET response_json = ? WHERE workspace_id = ? AND principal_id = ? AND key = ?', params: [JSON.stringify(result ?? null), ws, pid, key] },
    ]);
    return result;
  }

  /** Re-run a read-modify-write command when a concurrent writer bumped a version. */
  async retrying<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
    for (let i = 1; ; i++) {
      try {
        return await fn();
      } catch (err) {
        if (i >= attempts || !(err instanceof TowerError && err.code === 'conflict')) throw err;
      }
    }
  }
}
