import type { Actor, PolicyEvaluation } from '../domain/types.ts';
import { SPECS, toRow, upsertSql, type EntitySpec } from './codec.ts';
import { stmt, type SqlDriver, type SqlValue, type Stmt } from './sql.ts';

export type StreamType = 'workspace' | 'mission' | 'packet' | 'attempt' | 'runner' | 'decision' | 'rule' | 'link' | 'scope' | 'principal' | 'proposal' | 'integration';

export interface EventInput {
  stream: StreamType;
  id: string;
  /** Version the writer read. The event is stored at expected + 1; a concurrent writer collides. */
  expected: number;
  type: string;
  missionId?: string | null;
  payload?: unknown;
  policy?: PolicyEvaluation;
  evidenceRef?: string;
}

export interface TowerEvent {
  seq: number;
  id: string;
  workspaceId: string;
  streamType: string;
  streamId: string;
  streamVersion: number;
  type: string;
  actorId: string;
  actorKind: string;
  correlationId: string;
  missionId: string | null;
  policy: PolicyEvaluation | null;
  evidenceRef: string | null;
  payload: unknown;
  createdAt: string;
}

/**
 * Collects one command's writes. Commit runs them as a single atomic batch.
 * Any stale `expected` version makes the event insert violate
 * UNIQUE(stream_type, stream_id, stream_version) and nothing is applied.
 */
export class UnitOfWork {
  readonly stmts: Stmt[] = [];
  readonly events: EventInput[] = [];
  readonly actor: Actor;
  readonly now: string;
  readonly workspaceId: string;
  private readonly newId: () => string;

  constructor(actor: Actor, now: string, newId: () => string) {
    this.actor = actor;
    this.now = now;
    this.workspaceId = actor.principal.workspaceId;
    this.newId = newId;
  }

  event(e: EventInput): number {
    const version = e.expected + 1;
    this.events.push(e);
    this.stmts.push(
      stmt(
        `INSERT INTO events (id, workspace_id, stream_type, stream_id, stream_version, type, actor_id, actor_kind, correlation_id, mission_id, policy_json, evidence_ref, payload_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        `evt_${this.newId()}`,
        this.workspaceId,
        e.stream,
        e.id,
        version,
        e.type,
        this.actor.principal.id,
        this.actor.principal.kind,
        this.actor.correlationId,
        e.missionId ?? null,
        e.policy ? JSON.stringify(e.policy) : null,
        e.evidenceRef ?? null,
        JSON.stringify(e.payload ?? {}),
        this.now,
      ),
    );
    return version;
  }

  /**
   * Record an event on an entity's stream and upsert its projection at the new
   * version. `obj.version` must be the version that was read (0 for new entities).
   */
  save<T extends { id: string; version: number }>(
    stream: StreamType,
    spec: EntitySpec,
    obj: T,
    type: string,
    extra: Omit<EventInput, 'stream' | 'id' | 'expected' | 'type'> = {},
  ): T {
    const version = this.event({ stream, id: obj.id, expected: obj.version, type, ...extra });
    const next = { ...obj, version, ...('updatedAt' in obj ? { updatedAt: this.now } : {}) };
    this.put(spec, next);
    return next;
  }

  /** Upsert an entity projection (full row). Pair with `event` for the version guard. */
  put(spec: EntitySpec, obj: object): void {
    const { sql, params } = upsertSql(spec.table, toRow(spec, obj));
    this.stmts.push({ sql, params });
  }

  run(sql: string, ...params: SqlValue[]): void {
    this.stmts.push(stmt(sql, ...params));
  }

  async commit(db: SqlDriver): Promise<void> {
    await db.batch(this.stmts);
  }
}

export { SPECS };
