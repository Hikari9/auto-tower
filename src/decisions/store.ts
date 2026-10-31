import type { SqlDatabase } from '../storage/database.js';
import type {
  Advisory,
  Alternative,
  Decision,
  DecisionAnswer,
  DecisionCategory,
  DecisionLink,
  DecisionRequest,
  LinkStatus,
  Recommendation,
  RequiredAuthority,
  Urgency,
} from './types.js';

interface DecisionRow {
  workspace_id: string;
  id: string;
  version: number;
  status: string;
  dedupe_key: string;
  category: string;
  urgency: string;
  question: string;
  alternatives_json: string;
  recommendation_json: string | null;
  consequences: string;
  required_authority: string;
  evidence_json: string;
  affected_scope_json: string;
  request_json: string | null;
  advisory_json: string;
  created_by: string;
  created_at: string;
  effective_answer_version: number | null;
  effective_choice: string | null;
  answered_by: string | null;
  answered_at: string | null;
}

interface LinkRow {
  decision_id: string;
  mission_id: string;
  packet_id: string;
  status: string;
  reason: string | null;
  linked_at: string;
  resolved_at: string | null;
  resolved_by_answer_version: number | null;
}

const DECISION_COLUMNS =
  'workspace_id, id, version, status, dedupe_key, category, urgency, question, alternatives_json, recommendation_json, consequences, required_authority, evidence_json, affected_scope_json, request_json, advisory_json, created_by, created_at, effective_answer_version, effective_choice, answered_by, answered_at';

/** Highest urgency first, then the order items were raised. */
const INBOX_ORDER = `CASE urgency WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, created_seq, id`;

function toLink(row: LinkRow): DecisionLink {
  return {
    missionId: row.mission_id,
    packetId: row.packet_id === '' ? null : row.packet_id,
    status: row.status as LinkStatus,
    reason: row.reason,
    linkedAt: row.linked_at,
    resolvedAt: row.resolved_at,
    resolvedByAnswerVersion: row.resolved_by_answer_version,
  };
}

function toDecision(row: DecisionRow, links: DecisionLink[]): Decision {
  const answered =
    row.effective_answer_version !== null &&
    row.effective_choice !== null &&
    row.answered_by !== null &&
    row.answered_at !== null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    version: row.version,
    status: row.status as 'open' | 'answered',
    dedupeKey: row.dedupe_key,
    category: row.category as DecisionCategory,
    urgency: row.urgency as Urgency,
    question: row.question,
    alternatives: JSON.parse(row.alternatives_json) as Alternative[],
    recommendation:
      row.recommendation_json === null
        ? null
        : (JSON.parse(row.recommendation_json) as Recommendation),
    consequences: row.consequences,
    requiredAuthority: row.required_authority as RequiredAuthority,
    evidence: JSON.parse(row.evidence_json) as string[],
    affectedScope: JSON.parse(row.affected_scope_json) as string[],
    request:
      row.request_json === null
        ? null
        : (JSON.parse(row.request_json) as DecisionRequest),
    advisory: JSON.parse(row.advisory_json) as Advisory,
    createdBy: row.created_by,
    createdAt: row.created_at,
    effectiveAnswer: answered
      ? {
          version: row.effective_answer_version as number,
          choice: row.effective_choice as string,
          note: null,
          answeredBy: row.answered_by as string,
          answeredAt: row.answered_at as string,
        }
      : null,
    links,
  };
}

function linksFor(
  db: SqlDatabase,
  workspaceId: string,
  ids: readonly string[],
): Map<string, DecisionLink[]> {
  const byDecision = new Map<string, DecisionLink[]>();
  if (ids.length === 0) {
    return byDecision;
  }
  const marks = ids.map(() => '?').join(', ');
  const rows = db.all<LinkRow>(
    `SELECT decision_id, mission_id, packet_id, status, reason, linked_at, resolved_at, resolved_by_answer_version
     FROM decision_links WHERE workspace_id = ? AND decision_id IN (${marks})
     ORDER BY linked_at, mission_id, packet_id`,
    [workspaceId, ...ids],
  );
  for (const row of rows) {
    const list = byDecision.get(row.decision_id) ?? [];
    list.push(toLink(row));
    byDecision.set(row.decision_id, list);
  }
  return byDecision;
}

function withNotes(
  db: SqlDatabase,
  workspaceId: string,
  decisions: Decision[],
): Decision[] {
  for (const decision of decisions) {
    const effective = decision.effectiveAnswer;
    if (effective !== null) {
      effective.note =
        db.get<{ note: string | null }>(
          'SELECT note FROM decision_answers WHERE workspace_id = ? AND decision_id = ? AND version = ?',
          [workspaceId, decision.id, effective.version],
        )?.note ?? null;
    }
  }
  return decisions;
}

export function loadDecision(
  db: SqlDatabase,
  workspaceId: string,
  id: string,
): Decision | undefined {
  const row = db.get<DecisionRow>(
    `SELECT ${DECISION_COLUMNS} FROM decisions WHERE workspace_id = ? AND id = ?`,
    [workspaceId, id],
  );
  if (row === undefined) {
    return undefined;
  }
  const links = linksFor(db, workspaceId, [id]).get(id) ?? [];
  return withNotes(db, workspaceId, [toDecision(row, links)])[0];
}

export function loadDecisions(
  db: SqlDatabase,
  workspaceId: string,
  filter: { status: 'open' | 'answered' | 'all'; limit: number },
): Decision[] {
  const where = filter.status === 'all' ? '' : ' AND status = ?';
  const order =
    filter.status === 'answered'
      ? 'answered_at DESC, id'
      : `CASE status WHEN 'open' THEN 0 ELSE 1 END, ${INBOX_ORDER}`;
  const rows = db.all<DecisionRow>(
    `SELECT ${DECISION_COLUMNS} FROM decisions WHERE workspace_id = ?${where} ORDER BY ${order} LIMIT ?`,
    filter.status === 'all'
      ? [workspaceId, filter.limit]
      : [workspaceId, filter.status, filter.limit],
  );
  const links = linksFor(
    db,
    workspaceId,
    rows.map((row) => row.id),
  );
  return withNotes(
    db,
    workspaceId,
    rows.map((row) => toDecision(row, links.get(row.id) ?? [])),
  );
}

export function openDecisionIdByKey(
  db: SqlDatabase,
  workspaceId: string,
  dedupeKey: string,
): string | undefined {
  return db.get<{ id: string }>(
    "SELECT id FROM decisions WHERE workspace_id = ? AND dedupe_key = ? AND status = 'open'",
    [workspaceId, dedupeKey],
  )?.id;
}

export function loadAnswers(
  db: SqlDatabase,
  workspaceId: string,
  decisionId: string,
): DecisionAnswer[] {
  return db
    .all<{
      version: number;
      choice: string;
      note: string | null;
      answered_by: string;
      answered_at: string;
    }>(
      'SELECT version, choice, note, answered_by, answered_at FROM decision_answers WHERE workspace_id = ? AND decision_id = ? ORDER BY version',
      [workspaceId, decisionId],
    )
    .map((row) => ({
      version: row.version,
      choice: row.choice,
      note: row.note,
      answeredBy: row.answered_by,
      answeredAt: row.answered_at,
    }));
}
