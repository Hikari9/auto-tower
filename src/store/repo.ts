import { fail } from '../domain/errors.ts';
import type { Attempt, Decision, IssueLink, Mission, Packet, PolicyRule, Principal, Runner } from '../domain/types.ts';
import { fromRow, SPECS } from './codec.ts';
import type { SqlDriver, SqlValue } from './sql.ts';
import type { TowerEvent } from './uow.ts';

export interface WorkspaceRow {
  id: string;
  name: string;
  policyVersion: number;
  halted: boolean;
  settings: Record<string, unknown>;
  version: number;
  createdAt: string;
}

export interface Evidence {
  id: string;
  workspaceId: string;
  missionId: string;
  packetId: string | null;
  attemptId: string | null;
  kind: string;
  summary: string;
  uri: string | null;
  sha: string | null;
  verified: boolean;
  source: string;
  data: unknown;
  createdAt: string;
}

export interface Proposal {
  id: string;
  workspaceId: string;
  patternKey: string;
  proposed: { effect: 'allow'; action: string; resource: string; grantee: 'chief' | 'runner' | 'any'; conditions: Record<string, unknown>; note: string };
  evidence: string[];
  status: 'pending' | 'accepted' | 'declined';
  resolvedRuleId: string | null;
  resolvedBy: string | null;
  version: number;
  createdAt: string;
}

export interface Integration {
  id: string;
  workspaceId: string;
  provider: string;
  config: Record<string, unknown>;
  enabled: boolean;
  version: number;
  createdAt: string;
}

/** Read side. All reads are workspace-scoped by the caller. */
export class Repo {
  readonly db: SqlDriver;

  constructor(db: SqlDriver) {
    this.db = db;
  }

  private async one<T>(spec: (typeof SPECS)[keyof typeof SPECS], sql: string, params: SqlValue[]): Promise<T | undefined> {
    const row = await this.db.first<Record<string, unknown>>(sql, params);
    return row ? fromRow<T>(spec, row) : undefined;
  }

  private async many<T>(spec: (typeof SPECS)[keyof typeof SPECS], sql: string, params: SqlValue[]): Promise<T[]> {
    return (await this.db.all<Record<string, unknown>>(sql, params)).map((r) => fromRow<T>(spec, r));
  }

  async workspace(id: string): Promise<WorkspaceRow> {
    const row = await this.db.first<Record<string, unknown>>('SELECT * FROM workspaces WHERE id = ?', [id]);
    if (!row) return fail('not_found', `workspace ${id} not found`);
    return {
      id: row.id as string,
      name: row.name as string,
      policyVersion: row.policy_version as number,
      halted: Boolean(row.halted),
      settings: JSON.parse(row.settings_json as string),
      version: row.version as number,
      createdAt: row.created_at as string,
    };
  }

  async principalByTokenHash(hash: string): Promise<(Principal & { version: number }) | undefined> {
    return this.one(SPECS.principal, 'SELECT id, workspace_id, kind, name, scopes_json, status, version FROM principals WHERE token_hash = ?', [hash]);
  }

  async principal(ws: string, id: string): Promise<(Principal & { version: number; createdAt: string }) | undefined> {
    return this.one(SPECS.principal, 'SELECT id, workspace_id, kind, name, scopes_json, status, version, created_at FROM principals WHERE workspace_id = ? AND id = ?', [ws, id]);
  }

  async principals(ws: string): Promise<(Principal & { version: number; createdAt: string })[]> {
    return this.many(SPECS.principal, 'SELECT id, workspace_id, kind, name, scopes_json, status, version, created_at FROM principals WHERE workspace_id = ? ORDER BY created_at, rowid', [ws]);
  }

  async mission(ws: string, id: string): Promise<Mission> {
    const m = await this.one<Mission>(SPECS.mission, 'SELECT * FROM missions WHERE workspace_id = ? AND id = ?', [ws, id]);
    return m ?? fail('not_found', `mission ${id} not found`);
  }

  async missions(ws: string, f: { states?: string[]; parentId?: string | null; q?: string; limit?: number } = {}): Promise<Mission[]> {
    const where = ['workspace_id = ?'];
    const params: SqlValue[] = [ws];
    if (f.states?.length) {
      where.push(`state IN (${f.states.map(() => '?').join(',')})`);
      params.push(...f.states);
    }
    if (f.parentId !== undefined) {
      where.push(f.parentId === null ? 'parent_id IS NULL' : 'parent_id = ?');
      if (f.parentId !== null) params.push(f.parentId);
    }
    if (f.q) {
      where.push('(title LIKE ? OR intent LIKE ? OR outcome LIKE ?)');
      params.push(`%${f.q}%`, `%${f.q}%`, `%${f.q}%`);
    }
    params.push(Math.min(f.limit ?? 200, 500));
    return this.many(SPECS.mission, `SELECT * FROM missions WHERE ${where.join(' AND ')} ORDER BY priority ASC, created_at DESC LIMIT ?`, params);
  }

  async children(ws: string, parentId: string): Promise<Mission[]> {
    return this.many(SPECS.mission, 'SELECT * FROM missions WHERE workspace_id = ? AND parent_id = ?', [ws, parentId]);
  }

  async packet(ws: string, id: string): Promise<Packet> {
    const p = await this.one<Packet>(SPECS.packet, 'SELECT * FROM packets WHERE workspace_id = ? AND id = ?', [ws, id]);
    return p ?? fail('not_found', `packet ${id} not found`);
  }

  async packets(ws: string, missionId: string): Promise<Packet[]> {
    return this.many(SPECS.packet, 'SELECT * FROM packets WHERE workspace_id = ? AND mission_id = ? ORDER BY created_at, rowid', [ws, missionId]);
  }

  async packetsByState(ws: string, states: string[]): Promise<Packet[]> {
    return this.many(SPECS.packet, `SELECT * FROM packets WHERE workspace_id = ? AND state IN (${states.map(() => '?').join(',')}) ORDER BY created_at, rowid`, [ws, ...states]);
  }

  async attempt(ws: string, id: string): Promise<Attempt> {
    const a = await this.one<Attempt>(SPECS.attempt, 'SELECT * FROM attempts WHERE workspace_id = ? AND id = ?', [ws, id]);
    return a ?? fail('not_found', `attempt ${id} not found`);
  }

  async attemptsFor(ws: string, f: { runnerId?: string; packetId?: string; missionId?: string; states?: string[] }): Promise<Attempt[]> {
    const where = ['workspace_id = ?'];
    const params: SqlValue[] = [ws];
    if (f.runnerId) (where.push('runner_id = ?'), params.push(f.runnerId));
    if (f.packetId) (where.push('packet_id = ?'), params.push(f.packetId));
    if (f.missionId) (where.push('mission_id = ?'), params.push(f.missionId));
    if (f.states?.length) (where.push(`state IN (${f.states.map(() => '?').join(',')})`), params.push(...f.states));
    return this.many(SPECS.attempt, `SELECT * FROM attempts WHERE ${where.join(' AND ')} ORDER BY created_at, rowid`, params);
  }

  async scopeLock(scope: string): Promise<{ execScope: string; holderAttemptId: string | null; fence: number; version: number } | undefined> {
    const row = await this.db.first<Record<string, unknown>>('SELECT * FROM scope_locks WHERE exec_scope = ?', [scope]);
    if (!row) return undefined;
    return { execScope: scope, holderAttemptId: (row.holder_attempt_id as string) ?? null, fence: row.fence as number, version: row.version as number };
  }

  async heldScopes(ws: string): Promise<Set<string>> {
    const rows = await this.db.all<{ exec_scope: string }>('SELECT exec_scope FROM scope_locks WHERE workspace_id = ? AND holder_attempt_id IS NOT NULL', [ws]);
    return new Set(rows.map((r) => r.exec_scope));
  }

  async runner(ws: string, id: string): Promise<Runner> {
    const r = await this.one<Runner>(SPECS.runner, 'SELECT * FROM runners WHERE workspace_id = ? AND id = ?', [ws, id]);
    return r ?? fail('not_found', `runner ${id} not found`);
  }

  async runnerByPrincipal(principalId: string): Promise<Runner | undefined> {
    return this.one(SPECS.runner, 'SELECT * FROM runners WHERE principal_id = ?', [principalId]);
  }

  async runners(ws: string): Promise<Runner[]> {
    return this.many(SPECS.runner, 'SELECT * FROM runners WHERE workspace_id = ? ORDER BY name', [ws]);
  }

  async decision(ws: string, id: string): Promise<Decision> {
    const d = await this.one<Decision>(SPECS.decision, 'SELECT * FROM decisions WHERE workspace_id = ? AND id = ?', [ws, id]);
    if (!d) return fail('not_found', `decision ${id} not found`);
    d.linkedPackets = await this.decisionLinks(id);
    return d;
  }

  async decisionLinks(id: string): Promise<string[]> {
    return (await this.db.all<{ packet_id: string }>('SELECT packet_id FROM decision_links WHERE decision_id = ?', [id])).map((r) => r.packet_id);
  }

  async decisions(ws: string, f: { status?: string; missionId?: string; audience?: string } = {}): Promise<Decision[]> {
    const where = ['workspace_id = ?'];
    const params: SqlValue[] = [ws];
    if (f.status) (where.push('status = ?'), params.push(f.status));
    if (f.missionId) (where.push('mission_id = ?'), params.push(f.missionId));
    if (f.audience) (where.push('audience = ?'), params.push(f.audience));
    const list = await this.many<Decision>(
      SPECS.decision,
      `SELECT * FROM decisions WHERE ${where.join(' AND ')} ORDER BY CASE urgency WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, created_at, rowid`,
      params,
    );
    for (const d of list) d.linkedPackets = await this.decisionLinks(d.id);
    return list;
  }

  async openDecisionByDedupe(ws: string, key: string): Promise<Decision | undefined> {
    const d = await this.one<Decision>(SPECS.decision, "SELECT * FROM decisions WHERE workspace_id = ? AND dedupe_key = ? AND status = 'open'", [ws, key]);
    if (d) d.linkedPackets = await this.decisionLinks(d.id);
    return d;
  }

  async rules(ws: string, includeRevoked = false): Promise<PolicyRule[]> {
    return this.many(SPECS.rule, `SELECT * FROM policy_rules WHERE workspace_id = ? ${includeRevoked ? '' : "AND status = 'active'"} ORDER BY created_at, rowid`, [ws]);
  }

  async rule(ws: string, id: string): Promise<PolicyRule> {
    const r = await this.one<PolicyRule>(SPECS.rule, 'SELECT * FROM policy_rules WHERE workspace_id = ? AND id = ?', [ws, id]);
    return r ?? fail('not_found', `rule ${id} not found`);
  }

  async proposals(ws: string, status?: string): Promise<Proposal[]> {
    const rows = await this.db.all<Record<string, unknown>>(
      `SELECT * FROM rule_proposals WHERE workspace_id = ? ${status ? 'AND status = ?' : ''} ORDER BY created_at, rowid`,
      status ? [ws, status] : [ws],
    );
    return rows.map((r) => fromRow<Proposal>({ table: 'rule_proposals', json: ['proposed', 'evidence'] }, r));
  }

  async preferences(ws: string): Promise<{ key: string; value: unknown; observedCount: number; updatedAt: string }[]> {
    const rows = await this.db.all<Record<string, unknown>>('SELECT * FROM preferences WHERE workspace_id = ? ORDER BY key', [ws]);
    return rows.map((r) => ({ key: r.key as string, value: JSON.parse(r.value_json as string), observedCount: r.observed_count as number, updatedAt: r.updated_at as string }));
  }

  async links(ws: string, missionId: string): Promise<IssueLink[]> {
    return this.many(SPECS.link, 'SELECT * FROM issue_links WHERE workspace_id = ? AND mission_id = ? ORDER BY created_at, rowid', [ws, missionId]);
  }

  async link(ws: string, id: string): Promise<IssueLink> {
    const l = await this.one<IssueLink>(SPECS.link, 'SELECT * FROM issue_links WHERE workspace_id = ? AND id = ?', [ws, id]);
    return l ?? fail('not_found', `link ${id} not found`);
  }

  async linksByRef(ws: string, ref: string): Promise<IssueLink[]> {
    return this.many(SPECS.link, 'SELECT * FROM issue_links WHERE workspace_id = ? AND external_ref = ?', [ws, ref]);
  }

  async observableLinks(ws: string, provider: string): Promise<IssueLink[]> {
    return this.many(SPECS.link, 'SELECT * FROM issue_links WHERE workspace_id = ? AND provider = ? ORDER BY observed_at IS NOT NULL, observed_at', [ws, provider]);
  }

  async integration(ws: string, provider: string): Promise<Integration | undefined> {
    const row = await this.db.first<Record<string, unknown>>('SELECT * FROM integrations WHERE workspace_id = ? AND provider = ?', [ws, provider]);
    return row ? fromRow<Integration>({ table: 'integrations', json: ['config'], bool: ['enabled'] }, row) : undefined;
  }

  async integrations(ws: string): Promise<Integration[]> {
    const rows = await this.db.all<Record<string, unknown>>('SELECT * FROM integrations WHERE workspace_id = ?', [ws]);
    return rows.map((r) => fromRow<Integration>({ table: 'integrations', json: ['config'], bool: ['enabled'] }, r));
  }

  async evidence(ws: string, missionId: string): Promise<Evidence[]> {
    const rows = await this.db.all<Record<string, unknown>>('SELECT * FROM evidence WHERE workspace_id = ? AND mission_id = ? ORDER BY created_at, rowid', [ws, missionId]);
    return rows.map((r) => fromRow<Evidence>({ table: 'evidence', json: ['data'], bool: ['verified'] }, r));
  }

  async events(ws: string, f: { missionId?: string; streamId?: string; afterSeq?: number; limit?: number } = {}): Promise<TowerEvent[]> {
    const where = ['workspace_id = ?'];
    const params: SqlValue[] = [ws];
    if (f.missionId) (where.push('mission_id = ?'), params.push(f.missionId));
    if (f.streamId) (where.push('stream_id = ?'), params.push(f.streamId));
    if (f.afterSeq !== undefined) (where.push('seq > ?'), params.push(f.afterSeq));
    params.push(Math.min(f.limit ?? 200, 1000));
    const order = f.afterSeq !== undefined ? 'ASC' : 'DESC';
    const rows = await this.db.all<Record<string, unknown>>(`SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY seq ${order} LIMIT ?`, params);
    return rows.map((r) => fromRow<TowerEvent>({ table: 'events', json: ['policy', 'payload'] }, r));
  }

  async flags(ws: string): Promise<Record<string, unknown>> {
    const rows = await this.db.all<{ key: string; value_json: string }>('SELECT key, value_json FROM flags WHERE workspace_id = ?', [ws]);
    return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.value_json)]));
  }

  async idempotent(ws: string, principalId: string, key: string): Promise<{ requestHash: string; response: unknown } | undefined> {
    const row = await this.db.first<{ request_hash: string; response_json: string }>(
      'SELECT request_hash, response_json FROM idempotency WHERE workspace_id = ? AND principal_id = ? AND key = ?',
      [ws, principalId, key],
    );
    return row ? { requestHash: row.request_hash, response: JSON.parse(row.response_json) } : undefined;
  }
}
