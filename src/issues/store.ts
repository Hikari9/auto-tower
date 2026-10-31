import { missionStreamId } from '../core/types.js';
import type { SqlDatabase, SqlValue } from '../storage/database.js';
import type {
  Discrepancy,
  DiscrepancyKind,
  DiscrepancySource,
  IssueLinkRecord,
  LinkHistoryItem,
  ObservedSource,
  ObservedState,
  SyncConfig,
  SyncMode,
} from './types.js';

interface LinkRow {
  id: string;
  mission_id: string;
  url: string;
  provider: string | null;
  repo: string | null;
  issue_number: number | null;
  node_id: string | null;
  observed_state: ObservedState;
  observed_source: ObservedSource | null;
  observed_at: string | null;
  observed_title: string | null;
  polled_at: string | null;
  verified_closed_at: string | null;
  closed_by_tower_at: string | null;
  retry_not_before: string | null;
  exemption_status: IssueLinkRecord['exemption']['status'];
  exemption_reason: string | null;
  exemption_requested_by: string | null;
  exemption_requested_at: string | null;
  exemption_approved_by: string | null;
  exemption_approved_at: string | null;
  created_at: string;
  updated_at: string;
}

const LINK_COLUMNS =
  'id, mission_id, url, provider, repo, issue_number, node_id, observed_state, observed_source, observed_at, observed_title, polled_at, verified_closed_at, closed_by_tower_at, retry_not_before, exemption_status, exemption_reason, exemption_requested_by, exemption_requested_at, exemption_approved_by, exemption_approved_at, created_at, updated_at';

function toLink(row: LinkRow): IssueLinkRecord {
  return {
    id: row.id,
    missionId: row.mission_id,
    url: row.url,
    provider: row.provider,
    repo: row.repo,
    issueNumber: row.issue_number,
    nodeId: row.node_id,
    observedState: row.observed_state,
    observedSource: row.observed_source,
    observedAt: row.observed_at,
    observedTitle: row.observed_title,
    polledAt: row.polled_at,
    verifiedClosedAt: row.verified_closed_at,
    closedByTowerAt: row.closed_by_tower_at,
    retryNotBefore: row.retry_not_before,
    exemption: {
      status: row.exemption_status,
      reason: row.exemption_reason,
      requestedBy: row.exemption_requested_by,
      requestedAt: row.exemption_requested_at,
      approvedBy: row.exemption_approved_by,
      approvedAt: row.exemption_approved_at,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function loadLinks(
  db: SqlDatabase,
  workspaceId: string,
  missionId: string,
): IssueLinkRecord[] {
  return db
    .all<LinkRow>(
      `SELECT ${LINK_COLUMNS} FROM issue_links WHERE workspace_id = ? AND mission_id = ? ORDER BY created_at, id`,
      [workspaceId, missionId],
    )
    .map(toLink);
}

/**
 * Every URL the mission has ever carried as `required`, read from its event stream. A link that
 * was required once keeps counting after an update removes it or downgrades it, so this is the
 * set the completion guard answers for. Events are append-only, which makes the set only grow.
 */
export function loadEverRequiredUrls(
  db: SqlDatabase,
  workspaceId: string,
  missionId: string,
): Set<string> {
  const urls = new Set<string>();
  const rows = db.all<{ type: string; payload_json: string }>(
    "SELECT type, payload_json FROM events WHERE workspace_id = ? AND stream_id = ? AND type IN ('mission.created', 'mission.updated') ORDER BY version",
    [workspaceId, missionStreamId(missionId)],
  );
  for (const row of rows) {
    const payload = JSON.parse(row.payload_json) as {
      links?: unknown;
      changes?: { links?: unknown };
    };
    const links =
      row.type === 'mission.created' ? payload.links : payload.changes?.links;
    if (!Array.isArray(links)) {
      continue;
    }
    for (const link of links as { url?: unknown; classification?: unknown }[]) {
      if (link.classification === 'required' && typeof link.url === 'string') {
        urls.add(link.url);
      }
    }
  }
  return urls;
}

export function loadLinkByUrl(
  db: SqlDatabase,
  workspaceId: string,
  missionId: string,
  url: string,
): IssueLinkRecord | undefined {
  const row = db.get<LinkRow>(
    `SELECT ${LINK_COLUMNS} FROM issue_links WHERE workspace_id = ? AND mission_id = ? AND url = ?`,
    [workspaceId, missionId, url],
  );
  return row === undefined ? undefined : toLink(row);
}

export function loadLink(
  db: SqlDatabase,
  workspaceId: string,
  linkId: string,
): IssueLinkRecord | undefined {
  const row = db.get<LinkRow>(
    `SELECT ${LINK_COLUMNS} FROM issue_links WHERE workspace_id = ? AND id = ?`,
    [workspaceId, linkId],
  );
  return row === undefined ? undefined : toLink(row);
}

/** Tracked links that name one provider issue, across missions. */
export function loadLinksForIssue(
  db: SqlDatabase,
  workspaceId: string,
  provider: string,
  repo: string,
  issueNumber: number,
): IssueLinkRecord[] {
  return db
    .all<LinkRow>(
      `SELECT ${LINK_COLUMNS} FROM issue_links WHERE workspace_id = ? AND provider = ? AND repo = ? AND issue_number = ? ORDER BY created_at, id`,
      [workspaceId, provider, repo, issueNumber],
    )
    .map(toLink);
}

export function loadAllTrackedLinks(
  db: SqlDatabase,
  workspaceId: string,
): IssueLinkRecord[] {
  return db
    .all<LinkRow>(
      `SELECT ${LINK_COLUMNS} FROM issue_links WHERE workspace_id = ? AND provider IS NOT NULL ORDER BY (polled_at IS NOT NULL), polled_at, created_at, id`,
      [workspaceId],
    )
    .map(toLink);
}

export function insertLink(
  db: SqlDatabase,
  workspaceId: string,
  link: {
    id: string;
    missionId: string;
    url: string;
    provider: string | null;
    repo: string | null;
    issueNumber: number | null;
    at: string;
  },
): void {
  db.run(
    `INSERT INTO issue_links (workspace_id, id, mission_id, url, provider, repo, issue_number, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      workspaceId,
      link.id,
      link.missionId,
      link.url,
      link.provider,
      link.repo,
      link.issueNumber,
      link.at,
      link.at,
    ],
  );
}

export interface LinkUpdate {
  nodeId?: string | null;
  observedState?: ObservedState;
  observedSource?: ObservedSource | null;
  observedAt?: string | null;
  observedTitle?: string | null;
  polledAt?: string | null;
  verifiedClosedAt?: string | null;
  closedByTowerAt?: string | null;
  retryNotBefore?: string | null;
  exemptionStatus?: IssueLinkRecord['exemption']['status'];
  exemptionReason?: string | null;
  exemptionRequestedBy?: string | null;
  exemptionRequestedAt?: string | null;
  exemptionApprovedBy?: string | null;
  exemptionApprovedAt?: string | null;
}

const UPDATE_COLUMNS: Readonly<Record<keyof LinkUpdate, string>> = {
  nodeId: 'node_id',
  observedState: 'observed_state',
  observedSource: 'observed_source',
  observedAt: 'observed_at',
  observedTitle: 'observed_title',
  polledAt: 'polled_at',
  verifiedClosedAt: 'verified_closed_at',
  closedByTowerAt: 'closed_by_tower_at',
  retryNotBefore: 'retry_not_before',
  exemptionStatus: 'exemption_status',
  exemptionReason: 'exemption_reason',
  exemptionRequestedBy: 'exemption_requested_by',
  exemptionRequestedAt: 'exemption_requested_at',
  exemptionApprovedBy: 'exemption_approved_by',
  exemptionApprovedAt: 'exemption_approved_at',
};

export function updateLink(
  db: SqlDatabase,
  workspaceId: string,
  linkId: string,
  update: LinkUpdate,
  at: string,
): void {
  const sets: string[] = ['updated_at = ?'];
  const params: SqlValue[] = [at];
  for (const key of Object.keys(UPDATE_COLUMNS) as (keyof LinkUpdate)[]) {
    const value = update[key];
    if (value !== undefined) {
      sets.push(`${UPDATE_COLUMNS[key]} = ?`);
      params.push(value);
    }
  }
  params.push(workspaceId, linkId);
  db.run(
    `UPDATE issue_links SET ${sets.join(', ')} WHERE workspace_id = ? AND id = ?`,
    params,
  );
}

export function appendHistory(
  db: SqlDatabase,
  entry: {
    workspaceId: string;
    linkId: string;
    missionId: string;
    type: string;
    actorId: string;
    payload: unknown;
    at: string;
  },
): void {
  db.run(
    `INSERT INTO issue_link_history (workspace_id, link_id, mission_id, type, actor_id, payload_json, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.workspaceId,
      entry.linkId,
      entry.missionId,
      entry.type,
      entry.actorId,
      JSON.stringify(entry.payload),
      entry.at,
    ],
  );
}

export function loadHistory(
  db: SqlDatabase,
  workspaceId: string,
  missionId: string,
  page: { afterSeq: number; limit: number },
): LinkHistoryItem[] {
  return db
    .all<{
      seq: number;
      link_id: string;
      type: string;
      actor_id: string;
      payload_json: string;
      recorded_at: string;
    }>(
      `SELECT seq, link_id, type, actor_id, payload_json, recorded_at FROM issue_link_history
       WHERE workspace_id = ? AND mission_id = ? AND seq > ? ORDER BY seq LIMIT ?`,
      [workspaceId, missionId, page.afterSeq, page.limit],
    )
    .map((row) => ({
      seq: row.seq,
      linkId: row.link_id,
      type: row.type,
      actorId: row.actor_id,
      payload: JSON.parse(row.payload_json) as unknown,
      recordedAt: row.recorded_at,
    }));
}

interface DiscrepancyRow {
  id: string;
  mission_id: string;
  link_id: string;
  kind: DiscrepancyKind;
  detail: string;
  source: DiscrepancySource;
  requires_attention: number;
  retry_after_seconds: number | null;
  detected_by: string;
  detected_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution: string | null;
}

const DISCREPANCY_COLUMNS =
  'id, mission_id, link_id, kind, detail, source, requires_attention, retry_after_seconds, detected_by, detected_at, resolved_at, resolved_by, resolution';

function toDiscrepancy(row: DiscrepancyRow): Discrepancy {
  return {
    id: row.id,
    missionId: row.mission_id,
    linkId: row.link_id,
    kind: row.kind,
    detail: row.detail,
    source: row.source,
    requiresAttention: row.requires_attention === 1,
    retryAfterSeconds: row.retry_after_seconds,
    detectedBy: row.detected_by,
    detectedAt: row.detected_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    resolution: row.resolution,
  };
}

export function loadDiscrepancies(
  db: SqlDatabase,
  workspaceId: string,
  missionId: string,
  status: 'open' | 'resolved' | 'all',
): Discrepancy[] {
  const where =
    status === 'open'
      ? ' AND resolved_at IS NULL'
      : status === 'resolved'
        ? ' AND resolved_at IS NOT NULL'
        : '';
  return db
    .all<DiscrepancyRow>(
      `SELECT ${DISCREPANCY_COLUMNS} FROM issue_discrepancies WHERE workspace_id = ? AND mission_id = ?${where} ORDER BY detected_at, id`,
      [workspaceId, missionId],
    )
    .map(toDiscrepancy);
}

export function loadDiscrepancy(
  db: SqlDatabase,
  workspaceId: string,
  missionId: string,
  id: string,
): Discrepancy | undefined {
  const row = db.get<DiscrepancyRow>(
    `SELECT ${DISCREPANCY_COLUMNS} FROM issue_discrepancies WHERE workspace_id = ? AND mission_id = ? AND id = ?`,
    [workspaceId, missionId, id],
  );
  return row === undefined ? undefined : toDiscrepancy(row);
}

export function loadOpenDiscrepancyOfKind(
  db: SqlDatabase,
  workspaceId: string,
  linkId: string,
  kind: DiscrepancyKind,
): Discrepancy | undefined {
  const row = db.get<DiscrepancyRow>(
    `SELECT ${DISCREPANCY_COLUMNS} FROM issue_discrepancies WHERE workspace_id = ? AND link_id = ? AND kind = ? AND resolved_at IS NULL`,
    [workspaceId, linkId, kind],
  );
  return row === undefined ? undefined : toDiscrepancy(row);
}

export function insertDiscrepancy(
  db: SqlDatabase,
  workspaceId: string,
  d: Omit<Discrepancy, 'resolvedAt' | 'resolvedBy' | 'resolution'>,
): void {
  db.run(
    `INSERT INTO issue_discrepancies (workspace_id, id, mission_id, link_id, kind, detail, source, requires_attention, retry_after_seconds, detected_by, detected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      workspaceId,
      d.id,
      d.missionId,
      d.linkId,
      d.kind,
      d.detail,
      d.source,
      d.requiresAttention ? 1 : 0,
      d.retryAfterSeconds,
      d.detectedBy,
      d.detectedAt,
    ],
  );
}

/** Resolves open discrepancies of a link. `kinds` limits which. Returns how many it resolved. */
export function resolveDiscrepancies(
  db: SqlDatabase,
  workspaceId: string,
  filter: { linkId?: string; id?: string; kinds?: readonly DiscrepancyKind[] },
  by: string,
  resolution: string,
  at: string,
): number {
  const where = ['workspace_id = ?', 'resolved_at IS NULL'];
  const params: SqlValue[] = [workspaceId];
  if (filter.linkId !== undefined) {
    where.push('link_id = ?');
    params.push(filter.linkId);
  }
  if (filter.id !== undefined) {
    where.push('id = ?');
    params.push(filter.id);
  }
  if (filter.kinds !== undefined) {
    where.push(`kind IN (${filter.kinds.map(() => '?').join(', ')})`);
    params.push(...filter.kinds);
  }
  const before = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM issue_discrepancies WHERE ${where.join(' AND ')}`,
    params,
  );
  db.run(
    `UPDATE issue_discrepancies SET resolved_at = ?, resolved_by = ?, resolution = ? WHERE ${where.join(' AND ')}`,
    [at, by, resolution, ...params],
  );
  return before?.n ?? 0;
}

export function missionsNeedingAttention(
  db: SqlDatabase,
  workspaceId: string,
): string[] {
  return db
    .all<{ mission_id: string }>(
      `SELECT DISTINCT mission_id FROM issue_discrepancies WHERE workspace_id = ? AND resolved_at IS NULL AND requires_attention = 1 ORDER BY mission_id`,
      [workspaceId],
    )
    .map((row) => row.mission_id);
}

export function countOpenAttention(
  db: SqlDatabase,
  workspaceId: string,
  missionId: string,
): number {
  return (
    db.get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM issue_discrepancies WHERE workspace_id = ? AND mission_id = ? AND resolved_at IS NULL AND requires_attention = 1`,
      [workspaceId, missionId],
    )?.n ?? 0
  );
}

interface ConfigRow {
  provider: string;
  repo: string;
  mode: SyncMode;
  read_scope: number;
  write_scope: number;
  version: number;
  updated_by: string;
  updated_at: string;
}

function toConfig(row: ConfigRow): SyncConfig {
  return {
    provider: row.provider,
    repo: row.repo,
    mode: row.mode,
    readScope: row.read_scope === 1,
    writeScope: row.write_scope === 1,
    version: row.version,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

const CONFIG_COLUMNS =
  'provider, repo, mode, read_scope, write_scope, version, updated_by, updated_at';

export function loadConfigs(
  db: SqlDatabase,
  workspaceId: string,
): SyncConfig[] {
  return db
    .all<ConfigRow>(
      `SELECT ${CONFIG_COLUMNS} FROM issue_sync_configs WHERE workspace_id = ? ORDER BY provider, repo`,
      [workspaceId],
    )
    .map(toConfig);
}

export function loadConfig(
  db: SqlDatabase,
  workspaceId: string,
  provider: string,
  repo: string,
): SyncConfig | undefined {
  const row = db.get<ConfigRow>(
    `SELECT ${CONFIG_COLUMNS} FROM issue_sync_configs WHERE workspace_id = ? AND provider = ? AND repo = ?`,
    [workspaceId, provider, repo],
  );
  return row === undefined ? undefined : toConfig(row);
}

export function upsertConfig(
  db: SqlDatabase,
  workspaceId: string,
  config: Omit<SyncConfig, 'version'>,
): SyncConfig {
  const prior = loadConfig(db, workspaceId, config.provider, config.repo);
  const version = (prior?.version ?? 0) + 1;
  db.run(
    `INSERT INTO issue_sync_configs (workspace_id, provider, repo, mode, read_scope, write_scope, version, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (workspace_id, provider, repo) DO UPDATE SET
       mode = excluded.mode, read_scope = excluded.read_scope, write_scope = excluded.write_scope,
       version = excluded.version, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    [
      workspaceId,
      config.provider,
      config.repo,
      config.mode,
      config.readScope ? 1 : 0,
      config.writeScope ? 1 : 0,
      version,
      config.updatedBy,
      config.updatedAt,
    ],
  );
  return { ...config, version };
}

export function insertOutboundOp(
  db: SqlDatabase,
  workspaceId: string,
  op: { id: string; linkId: string; requestedBy: string; at: string },
): void {
  db.run(
    `INSERT INTO issue_outbound_ops (workspace_id, id, link_id, action, requested_by, requested_at)
     VALUES (?, ?, ?, 'close', ?, ?)`,
    [workspaceId, op.id, op.linkId, op.requestedBy, op.at],
  );
}

export function completeOutboundOp(
  db: SqlDatabase,
  workspaceId: string,
  id: string,
  outcome: 'succeeded' | 'failed',
  at: string,
): void {
  db.run(
    'UPDATE issue_outbound_ops SET outcome = ?, completed_at = ? WHERE workspace_id = ? AND id = ?',
    [outcome, at, workspaceId, id],
  );
}

export interface OutboundOp {
  id: string;
  linkId: string;
  requestedAt: string;
  outcome: 'succeeded' | 'failed' | null;
  echoSeenAt: string | null;
}

/** The newest write of a link that no webhook has echoed yet and that did not fail. */
export function loadPendingEchoOp(
  db: SqlDatabase,
  workspaceId: string,
  linkId: string,
): OutboundOp | undefined {
  const row = db.get<{
    id: string;
    link_id: string;
    requested_at: string;
    outcome: 'succeeded' | 'failed' | null;
    echo_seen_at: string | null;
  }>(
    `SELECT id, link_id, requested_at, outcome, echo_seen_at FROM issue_outbound_ops
     WHERE workspace_id = ? AND link_id = ? AND echo_seen_at IS NULL AND (outcome IS NULL OR outcome = 'succeeded')
     ORDER BY requested_at DESC, id DESC LIMIT 1`,
    [workspaceId, linkId],
  );
  return row === undefined
    ? undefined
    : {
        id: row.id,
        linkId: row.link_id,
        requestedAt: row.requested_at,
        outcome: row.outcome,
        echoSeenAt: row.echo_seen_at,
      };
}

export function loadOpById(
  db: SqlDatabase,
  workspaceId: string,
  id: string,
): OutboundOp | undefined {
  const row = db.get<{
    id: string;
    link_id: string;
    requested_at: string;
    outcome: 'succeeded' | 'failed' | null;
    echo_seen_at: string | null;
  }>(
    'SELECT id, link_id, requested_at, outcome, echo_seen_at FROM issue_outbound_ops WHERE workspace_id = ? AND id = ?',
    [workspaceId, id],
  );
  return row === undefined
    ? undefined
    : {
        id: row.id,
        linkId: row.link_id,
        requestedAt: row.requested_at,
        outcome: row.outcome,
        echoSeenAt: row.echo_seen_at,
      };
}

export function markEchoSeen(
  db: SqlDatabase,
  workspaceId: string,
  id: string,
  at: string,
): void {
  db.run(
    'UPDATE issue_outbound_ops SET echo_seen_at = ? WHERE workspace_id = ? AND id = ? AND echo_seen_at IS NULL',
    [at, workspaceId, id],
  );
}

export function deliverySeen(
  db: SqlDatabase,
  workspaceId: string,
  provider: string,
  deliveryId: string,
): boolean {
  return (
    db.get(
      'SELECT 1 AS one FROM webhook_deliveries WHERE workspace_id = ? AND provider = ? AND delivery_id = ?',
      [workspaceId, provider, deliveryId],
    ) !== undefined
  );
}

export function recordDelivery(
  db: SqlDatabase,
  workspaceId: string,
  delivery: {
    provider: string;
    deliveryId: string;
    event: string;
    outcome: string;
    at: string;
  },
): void {
  db.run(
    `INSERT INTO webhook_deliveries (workspace_id, provider, delivery_id, event, outcome, received_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      workspaceId,
      delivery.provider,
      delivery.deliveryId,
      delivery.event,
      delivery.outcome,
      delivery.at,
    ],
  );
}
