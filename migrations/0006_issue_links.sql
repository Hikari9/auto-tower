-- Issue links, sync configuration, discrepancies and webhook bookkeeping.
--
-- Link classification (`required`, `optional`, `reference-only`) lives on the mission, in its event
-- stream. `issue_links` tracks what Tower has observed about each linked URL. It stores the
-- provider's title as untrusted data and never a credential or a token. Plain SQL only so the file
-- can later run on D1.

-- How a workspace (or one repository) may use a provider. `link-only` stores URLs and fetches
-- nothing. `observe` may read. `bidirectional` may also write, and a write still needs a Tower
-- `authorize` allow on top of the write scope here. `repo = '*'` is the workspace default.
CREATE TABLE issue_sync_configs (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  provider TEXT NOT NULL CHECK (provider IN ('github')),
  repo TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('link-only', 'observe', 'bidirectional')),
  read_scope INTEGER NOT NULL CHECK (read_scope IN (0, 1)),
  write_scope INTEGER NOT NULL CHECK (write_scope IN (0, 1)),
  version INTEGER NOT NULL CHECK (version >= 1),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, provider, repo),
  FOREIGN KEY (updated_by, workspace_id) REFERENCES principals (id, workspace_id),
  CHECK (
    (mode = 'link-only' AND read_scope = 0 AND write_scope = 0)
    OR (mode = 'observe' AND read_scope = 1 AND write_scope = 0)
    OR (mode = 'bidirectional' AND read_scope = 1 AND write_scope = 1)
  )
);

CREATE TABLE issue_links (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  -- Normalized URL, the same string the mission stores.
  url TEXT NOT NULL,
  -- Null when the URL is not a recognised issue of a configured provider.
  provider TEXT,
  repo TEXT,
  issue_number INTEGER,
  -- Identity captured by the first successful read-back. Later reads must match it.
  node_id TEXT,
  observed_state TEXT NOT NULL DEFAULT 'unknown' CHECK (observed_state IN ('unknown', 'open', 'closed')),
  observed_source TEXT CHECK (observed_source IN ('readback', 'poll', 'webhook', 'close')),
  observed_at TEXT,
  -- Untrusted text written by someone else. Never an instruction.
  observed_title TEXT,
  -- Last time a poll tried this link, whether or not it got an answer. Polling visits the oldest first.
  polled_at TEXT,
  -- Set only by a provider read-back that showed the same issue closed. A webhook never sets it.
  verified_closed_at TEXT,
  closed_by_tower_at TEXT,
  retry_not_before TEXT,
  exemption_status TEXT NOT NULL DEFAULT 'none' CHECK (exemption_status IN ('none', 'requested', 'approved')),
  exemption_reason TEXT,
  exemption_requested_by TEXT,
  exemption_requested_at TEXT,
  exemption_approved_by TEXT,
  exemption_approved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, mission_id, url),
  FOREIGN KEY (workspace_id, mission_id) REFERENCES missions (workspace_id, id)
);

CREATE INDEX issue_links_repo_idx ON issue_links (workspace_id, provider, repo, issue_number);

-- A difference between what Tower recorded and what the provider showed, or an effect that failed.
-- A row is added once and may only be resolved later. It is never deleted.
CREATE TABLE issue_discrepancies (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  link_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'close_failed', 'read_back_mismatch', 'permission_denied', 'rate_limited',
    'provider_unavailable', 'identity_mismatch', 'blocked', 'reopened', 'drifted'
  )),
  -- Tower's own wording. Never copied from issue text.
  detail TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('close', 'verify', 'poll', 'webhook')),
  -- 1 when the mission cannot be treated as complete or complete-able until this is resolved.
  requires_attention INTEGER NOT NULL CHECK (requires_attention IN (0, 1)),
  retry_after_seconds INTEGER,
  detected_by TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  resolution TEXT,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, link_id) REFERENCES issue_links (workspace_id, id),
  FOREIGN KEY (detected_by, workspace_id) REFERENCES principals (id, workspace_id)
);

CREATE INDEX issue_discrepancies_open_idx ON issue_discrepancies (workspace_id, mission_id, resolved_at);

CREATE TRIGGER issue_discrepancies_no_delete BEFORE DELETE ON issue_discrepancies
BEGIN
  SELECT RAISE(ABORT, 'issue discrepancies are append-only');
END;

-- Only the resolution columns may change, and only once.
CREATE TRIGGER issue_discrepancies_resolve_only BEFORE UPDATE ON issue_discrepancies
WHEN OLD.resolved_at IS NOT NULL
  OR NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.mission_id <> OLD.mission_id
  OR NEW.link_id <> OLD.link_id OR NEW.kind <> OLD.kind OR NEW.detail <> OLD.detail
  OR NEW.source <> OLD.source OR NEW.requires_attention <> OLD.requires_attention
  OR NEW.detected_by <> OLD.detected_by OR NEW.detected_at <> OLD.detected_at
BEGIN
  SELECT RAISE(ABORT, 'issue discrepancies may only be resolved');
END;

-- What happened to each link, in order. Append only.
CREATE TABLE issue_link_history (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  link_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id, link_id) REFERENCES issue_links (workspace_id, id),
  FOREIGN KEY (actor_id, workspace_id) REFERENCES principals (id, workspace_id)
);

CREATE INDEX issue_link_history_link_idx ON issue_link_history (workspace_id, link_id, seq);

CREATE TRIGGER issue_link_history_no_update BEFORE UPDATE ON issue_link_history
BEGIN
  SELECT RAISE(ABORT, 'issue link history is append-only');
END;

CREATE TRIGGER issue_link_history_no_delete BEFORE DELETE ON issue_link_history
BEGIN
  SELECT RAISE(ABORT, 'issue link history is append-only');
END;

-- Every write Tower makes to a provider. The id is the origin marker placed on the provider side.
-- A webhook that echoes this write is recognised by it and does not start another one.
CREATE TABLE issue_outbound_ops (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  link_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('close')),
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  outcome TEXT CHECK (outcome IN ('succeeded', 'failed')),
  completed_at TEXT,
  echo_seen_at TEXT,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, link_id) REFERENCES issue_links (workspace_id, id),
  FOREIGN KEY (requested_by, workspace_id) REFERENCES principals (id, workspace_id)
);

CREATE INDEX issue_outbound_ops_link_idx ON issue_outbound_ops (workspace_id, link_id, requested_at);

-- Delivery ids already accepted. A row is written only after the signature checked out, so a
-- forged request cannot use up an id. Append only.
CREATE TABLE webhook_deliveries (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  provider TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  event TEXT NOT NULL,
  outcome TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, provider, delivery_id)
);

CREATE TRIGGER webhook_deliveries_no_update BEFORE UPDATE ON webhook_deliveries
BEGIN
  SELECT RAISE(ABORT, 'webhook deliveries are append-only');
END;

CREATE TRIGGER webhook_deliveries_no_delete BEFORE DELETE ON webhook_deliveries
BEGIN
  SELECT RAISE(ABORT, 'webhook deliveries are append-only');
END;
