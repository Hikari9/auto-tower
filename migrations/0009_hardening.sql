-- Hardening: emergency halt, flag history, webhook payload dedupe, and lookup indexes.
-- Plain SQL so the file can later run on D1.

-- Emergency halt. One row per workspace says whether new dispatch and guarded effects are stopped.
-- Nothing else is touched by a halt: missions, attempts, leases and decisions stay exactly as they were.
CREATE TABLE ops_halt (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
  halted INTEGER NOT NULL CHECK (halted IN (0, 1)),
  reason TEXT,
  changed_by TEXT NOT NULL,
  changed_at TEXT NOT NULL,
  FOREIGN KEY (changed_by, workspace_id) REFERENCES principals (id, workspace_id)
);

-- Every halt and every resume, with who and why. Append only.
CREATE TABLE ops_halt_history (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  action TEXT NOT NULL CHECK (action IN ('halt', 'resume')),
  reason TEXT,
  actor_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  FOREIGN KEY (actor_id, workspace_id) REFERENCES principals (id, workspace_id)
);

CREATE INDEX ops_halt_history_ws_idx ON ops_halt_history (workspace_id, seq);

CREATE TRIGGER ops_halt_history_no_update BEFORE UPDATE ON ops_halt_history
BEGIN
  SELECT RAISE(ABORT, 'halt history is append-only');
END;

CREATE TRIGGER ops_halt_history_no_delete BEFORE DELETE ON ops_halt_history
BEGIN
  SELECT RAISE(ABORT, 'halt history is append-only');
END;

-- Every change to a feature flag: who, the old and new setting, the rule it named, and when.
-- feature_flags holds only the latest row, so this is the record of how it got there. Append only.
CREATE TABLE feature_flag_history (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  flag TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  old_enabled INTEGER CHECK (old_enabled IS NULL OR old_enabled IN (0, 1)),
  new_enabled INTEGER NOT NULL CHECK (new_enabled IN (0, 1)),
  provider_id TEXT,
  budget_cents INTEGER,
  policy_rule_id TEXT,
  old_policy_rule_id TEXT,
  changed_at TEXT NOT NULL,
  FOREIGN KEY (changed_by, workspace_id) REFERENCES principals (id, workspace_id)
);

CREATE INDEX feature_flag_history_ws_idx ON feature_flag_history (workspace_id, seq);

CREATE TRIGGER feature_flag_history_no_update BEFORE UPDATE ON feature_flag_history
BEGIN
  SELECT RAISE(ABORT, 'flag history is append-only');
END;

CREATE TRIGGER feature_flag_history_no_delete BEFORE DELETE ON feature_flag_history
BEGIN
  SELECT RAISE(ABORT, 'flag history is append-only');
END;

-- A signed webhook body replayed under a new delivery id has no second effect: the hash of the
-- raw body is kept beside the delivery id. Rows from before this column have no hash.
ALTER TABLE webhook_deliveries ADD COLUMN payload_hash TEXT;

CREATE UNIQUE INDEX webhook_deliveries_payload_idx
  ON webhook_deliveries (workspace_id, provider, payload_hash)
  WHERE payload_hash IS NOT NULL;

-- Claim-refusal dedupe and the holds shown on a mission look up fleet_audit by attempt, policy
-- version and mission. Without these every poll scanned the workspace's audit.
CREATE INDEX fleet_audit_claim_attempt_idx ON fleet_audit (
  workspace_id,
  json_extract(detail_json, '$.attemptId'),
  json_extract(detail_json, '$.policyVersion')
) WHERE kind = 'claim.authority_denied';

CREATE INDEX fleet_audit_claim_mission_idx ON fleet_audit (
  workspace_id,
  json_extract(detail_json, '$.missionId'),
  seq
) WHERE kind = 'claim.authority_denied';

-- Closed MCP sessions are purged after a retention window. This keeps that cheap.
CREATE INDEX mcp_sessions_closed_idx ON mcp_sessions (closed_at) WHERE closed_at IS NOT NULL;
