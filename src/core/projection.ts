import type { SqlDatabase, SqlValue } from '../storage/database.js';
import type { MissionState, Priority, Risk, Size } from './types.js';

export interface MissionSummary {
  id: string;
  version: number;
  state: MissionState['state'];
  title: string;
  priority: Priority;
  risk: Risk;
  size: Size;
  parentId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
}

interface SummaryRow {
  id: string;
  version: number;
  state: MissionState['state'];
  title: string;
  priority: Priority;
  risk: Risk;
  size: Size;
  parent_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  cancelled_at: string | null;
}

const SUMMARY_COLUMNS =
  'id, version, state, title, priority, risk, size, parent_id, created_by, created_at, updated_at, completed_at, cancelled_at';

/**
 * Writes the current state of one mission and its packets, dependencies and attempts.
 * Must run in the same transaction as the event that produced the state. The child rows
 * are replaced wholesale, which is safe because the projection is derived data.
 * `createdSeq` is used only when the mission row is first inserted.
 */
export function writeProjection(
  db: SqlDatabase,
  state: MissionState,
  createdSeq: number,
): void {
  const ws = state.workspaceId;
  db.run(
    'DELETE FROM execution_attempts WHERE workspace_id = ? AND mission_id = ?',
    [ws, state.id],
  );
  db.run(
    `DELETE FROM packet_dependencies WHERE workspace_id = ? AND packet_id IN
       (SELECT id FROM work_packets WHERE workspace_id = ? AND mission_id = ?)`,
    [ws, ws, state.id],
  );
  db.run('DELETE FROM work_packets WHERE workspace_id = ? AND mission_id = ?', [
    ws,
    state.id,
  ]);

  db.run(
    `INSERT INTO missions (workspace_id, id, version, created_seq, state, title, intent, priority, risk, size,
        parent_id, required_for_parent, created_by, created_at, updated_at, completed_at, cancelled_at, snapshot_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (workspace_id, id) DO UPDATE SET
        version = excluded.version, state = excluded.state, title = excluded.title, intent = excluded.intent,
        priority = excluded.priority, risk = excluded.risk, size = excluded.size,
        updated_at = excluded.updated_at, completed_at = excluded.completed_at,
        cancelled_at = excluded.cancelled_at, snapshot_json = excluded.snapshot_json`,
    [
      ws,
      state.id,
      state.version,
      createdSeq,
      state.state,
      state.title,
      state.intent,
      state.priority,
      state.risk,
      state.size,
      state.parentId,
      state.requiredForParent ? 1 : 0,
      state.createdBy,
      state.createdAt,
      state.updatedAt,
      state.completedAt,
      state.cancelledAt,
      JSON.stringify(state),
    ],
  );

  for (const packet of state.packets) {
    db.run(
      `INSERT INTO work_packets (workspace_id, id, mission_id, position, title, status, required,
          authorized_at, authorized_by, verified_at, verified_by, active_attempt_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ws,
        packet.id,
        state.id,
        packet.position,
        packet.title,
        packet.status,
        packet.required ? 1 : 0,
        packet.authorization?.at ?? null,
        packet.authorization?.by ?? null,
        packet.verification?.at ?? null,
        packet.verification?.by ?? null,
        packet.activeAttemptId,
        packet.createdAt,
        packet.updatedAt,
      ],
    );
  }
  // Dependencies go in after every packet row exists, since each edge points at two packets.
  for (const packet of state.packets) {
    for (const dependsOn of packet.dependsOn) {
      db.run(
        'INSERT INTO packet_dependencies (workspace_id, packet_id, depends_on_packet_id) VALUES (?, ?, ?)',
        [ws, packet.id, dependsOn],
      );
    }
  }
  for (const attempt of state.attempts) {
    db.run(
      `INSERT INTO execution_attempts (workspace_id, id, mission_id, packet_id, number, runner_id, status,
          dispatched_at, started_at, reported_at, reported_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ws,
        attempt.id,
        state.id,
        attempt.packetId,
        attempt.number,
        attempt.runnerId,
        attempt.status,
        attempt.dispatchedAt,
        attempt.startedAt,
        attempt.reportedAt,
        attempt.report?.by ?? null,
      ],
    );
  }
}

export function loadMission(
  db: SqlDatabase,
  workspaceId: string,
  missionId: string,
): MissionState | undefined {
  const row = db.get<{ snapshot_json: string }>(
    'SELECT snapshot_json FROM missions WHERE workspace_id = ? AND id = ?',
    [workspaceId, missionId],
  );
  return row === undefined
    ? undefined
    : (JSON.parse(row.snapshot_json) as MissionState);
}

export function loadChildren(
  db: SqlDatabase,
  workspaceId: string,
  parentId: string,
): MissionState[] {
  return db
    .all<{ snapshot_json: string }>(
      'SELECT snapshot_json FROM missions WHERE workspace_id = ? AND parent_id = ? ORDER BY created_seq',
      [workspaceId, parentId],
    )
    .map((row) => JSON.parse(row.snapshot_json) as MissionState);
}

export interface SearchQuery {
  text?: string;
  states?: readonly MissionState['state'][];
  parentId?: string;
  priority?: Priority;
  risk?: Risk;
  limit: number;
  offset: number;
}

export interface SearchResult {
  items: MissionSummary[];
  total: number;
  limit: number;
  offset: number;
}

/** Escapes LIKE wildcards so a search for `50%` matches the literal text. */
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

export function searchMissions(
  db: SqlDatabase,
  workspaceId: string,
  query: SearchQuery,
): SearchResult {
  const where = ['workspace_id = ?'];
  const params: SqlValue[] = [workspaceId];
  if (query.text !== undefined && query.text !== '') {
    where.push("(title LIKE ? ESCAPE '\\' OR intent LIKE ? ESCAPE '\\')");
    params.push(likePattern(query.text), likePattern(query.text));
  }
  if (query.states !== undefined && query.states.length > 0) {
    where.push(`state IN (${query.states.map(() => '?').join(', ')})`);
    params.push(...query.states);
  }
  for (const [column, value] of [
    ['parent_id', query.parentId],
    ['priority', query.priority],
    ['risk', query.risk],
  ] as const) {
    if (value !== undefined) {
      where.push(`${column} = ?`);
      params.push(value);
    }
  }
  const clause = where.join(' AND ');
  const total =
    db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM missions WHERE ${clause}`,
      params,
    )?.n ?? 0;
  const rows = db.all<SummaryRow>(
    `SELECT ${SUMMARY_COLUMNS} FROM missions WHERE ${clause}
     ORDER BY updated_at DESC, created_seq DESC LIMIT ? OFFSET ?`,
    [...params, query.limit, query.offset],
  );
  return {
    items: rows.map(toSummary),
    total,
    limit: query.limit,
    offset: query.offset,
  };
}

function toSummary(row: SummaryRow): MissionSummary {
  return {
    id: row.id,
    version: row.version,
    state: row.state,
    title: row.title,
    priority: row.priority,
    risk: row.risk,
    size: row.size,
    parentId: row.parent_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    cancelledAt: row.cancelled_at,
  };
}

/** Missions the scheduler manages, most urgent first, ties broken by creation order. */
export function listSchedulableMissionIds(
  db: SqlDatabase,
  workspaceId: string,
  states: readonly MissionState['state'][],
): string[] {
  return db
    .all<{ id: string }>(
      `SELECT id FROM missions WHERE workspace_id = ? AND state IN (${states.map(() => '?').join(', ')})
       ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
                created_seq`,
      [workspaceId, ...states],
    )
    .map((row) => row.id);
}
