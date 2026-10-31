-- Runner fleet: attested enrollment, runners, leases with fencing tokens, progress, checkpoints,
-- receipts and an append-only audit of every refusal. Plain SQL only so the file can later run on D1.
--
-- Nothing here references the mission projection tables. Those rows are deleted and rewritten on
-- every mission event, so a foreign key into them would block the projection.

-- A single-use, expiring enrollment issued by a human. The enrollment token is an api token of the
-- runner's future principal, narrowed to `runner:read`, so only its digest is stored (api_tokens).
-- The human pins the client version and build digest here; registration must present exactly these.
CREATE TABLE runner_enrollments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  token_id TEXT NOT NULL UNIQUE,
  principal_id TEXT NOT NULL,
  name TEXT NOT NULL,
  pinned_version TEXT NOT NULL,
  pinned_digest TEXT NOT NULL,
  allowed_scopes_json TEXT NOT NULL,
  max_concurrent INTEGER NOT NULL CHECK (max_concurrent >= 1),
  issued_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  runner_id TEXT,
  CHECK ((used_at IS NULL) = (runner_id IS NULL)),
  FOREIGN KEY (issued_by, workspace_id) REFERENCES principals (id, workspace_id),
  FOREIGN KEY (principal_id, workspace_id) REFERENCES principals (id, workspace_id)
);

-- What a human pinned cannot change, and a used token cannot be reused, even through direct SQL.
CREATE TRIGGER runner_enrollments_pinned BEFORE UPDATE ON runner_enrollments
WHEN NEW.token_id IS NOT OLD.token_id
  OR NEW.principal_id IS NOT OLD.principal_id
  OR NEW.pinned_version IS NOT OLD.pinned_version
  OR NEW.pinned_digest IS NOT OLD.pinned_digest
  OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.issued_by IS NOT OLD.issued_by
  OR NEW.workspace_id IS NOT OLD.workspace_id
  OR (OLD.used_at IS NOT NULL AND (NEW.used_at IS NOT OLD.used_at OR NEW.runner_id IS NOT OLD.runner_id))
BEGIN
  SELECT RAISE(ABORT, 'enrollment tokens are pinned and single use');
END;

CREATE TRIGGER runner_enrollments_no_delete BEFORE DELETE ON runner_enrollments
BEGIN
  SELECT RAISE(ABORT, 'enrollments are append-only');
END;

-- A registered runner. `id` is its principal id. The credential and the attested version and
-- digest are bound at registration and never change: an upgrade is a new enrollment.
CREATE TABLE runners (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  enrollment_id TEXT NOT NULL REFERENCES runner_enrollments(id),
  token_id TEXT NOT NULL,
  bound_version TEXT NOT NULL,
  bound_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'quarantined')),
  quarantine_reason TEXT,
  capabilities_json TEXT NOT NULL,
  allowed_scopes_json TEXT NOT NULL,
  max_concurrent INTEGER NOT NULL CHECK (max_concurrent >= 0),
  last_seen_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (enrollment_id),
  FOREIGN KEY (id, workspace_id) REFERENCES principals (id, workspace_id)
);

CREATE TRIGGER runners_bound BEFORE UPDATE ON runners
WHEN NEW.bound_version IS NOT OLD.bound_version
  OR NEW.bound_digest IS NOT OLD.bound_digest
  OR NEW.token_id IS NOT OLD.token_id
  OR NEW.enrollment_id IS NOT OLD.enrollment_id
BEGIN
  SELECT RAISE(ABORT, 'a runner is bound to its enrolled credential, version and digest');
END;

-- A lease gives one runner the right to mutate one execution scope for one attempt.
-- `fence` is a per-scope counter that only grows. Reconciling or reassigning issues a new one,
-- so a holder that still has an old token is refused.
CREATE TABLE runner_leases (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  fence INTEGER NOT NULL CHECK (fence >= 1),
  attempt_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  packet_id TEXT NOT NULL,
  runner_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('held', 'recovering', 'completed', 'fenced', 'cancelled', 'released')),
  granted_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_proof_at TEXT NOT NULL,
  delivered_at TEXT,
  recovering_since TEXT,
  -- The fence a reconcile replaced, so a retried reconcile whose answer was lost still succeeds.
  reconciled_from INTEGER,
  progress_seq INTEGER NOT NULL DEFAULT 0 CHECK (progress_seq >= 0),
  reassign_failures INTEGER NOT NULL DEFAULT 0,
  reassign_not_before TEXT,
  closed_at TEXT,
  close_reason TEXT,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, scope_key, fence),
  FOREIGN KEY (runner_id, workspace_id) REFERENCES principals (id, workspace_id)
);

-- The guarantee: at most one live lease per mutable execution scope, and one per attempt.
-- A concurrent second claim fails on this index, inside the claiming transaction.
CREATE UNIQUE INDEX runner_leases_one_live_per_scope
  ON runner_leases (workspace_id, scope_key) WHERE status IN ('held', 'recovering');
CREATE UNIQUE INDEX runner_leases_one_live_per_attempt
  ON runner_leases (workspace_id, attempt_id) WHERE status IN ('held', 'recovering');
CREATE INDEX runner_leases_attempt_idx ON runner_leases (workspace_id, attempt_id);
CREATE INDEX runner_leases_runner_idx ON runner_leases (workspace_id, runner_id, status);
CREATE INDEX runner_leases_expiry_idx ON runner_leases (workspace_id, status, expires_at);

CREATE TRIGGER runner_leases_no_delete BEFORE DELETE ON runner_leases
BEGIN
  SELECT RAISE(ABORT, 'leases are append-only');
END;

-- A closed lease stays closed.
CREATE TRIGGER runner_leases_closed BEFORE UPDATE ON runner_leases
WHEN OLD.status IN ('completed', 'fenced', 'cancelled', 'released')
BEGIN
  SELECT RAISE(ABORT, 'a closed lease cannot change');
END;

-- Backoff for an attempt whose claim lost the scope.
CREATE TABLE runner_claim_backoff (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  attempt_id TEXT NOT NULL,
  failures INTEGER NOT NULL CHECK (failures >= 0),
  not_before TEXT NOT NULL,
  PRIMARY KEY (workspace_id, attempt_id)
);

-- Redacted progress, checkpoints and receipts. Immutable once written.
CREATE TABLE runner_progress (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  lease_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  runner_id TEXT NOT NULL,
  fence INTEGER NOT NULL,
  body_hash TEXT NOT NULL,
  message TEXT NOT NULL,
  data_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, lease_id, seq)
);

CREATE TABLE runner_checkpoints (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,
  runner_id TEXT NOT NULL,
  fence INTEGER NOT NULL,
  ref TEXT NOT NULL,
  commit_sha TEXT,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id)
);

CREATE INDEX runner_checkpoints_attempt_idx ON runner_checkpoints (workspace_id, attempt_id, recorded_at);

CREATE TABLE runner_receipts (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  runner_id TEXT NOT NULL,
  receipt_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  fence INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
  body_hash TEXT NOT NULL,
  summary TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, runner_id, receipt_id)
);

CREATE UNIQUE INDEX runner_receipts_one_per_attempt ON runner_receipts (workspace_id, attempt_id);

-- Every lifecycle change and every refusal, including fenced writes. Detail is redacted before insert.
CREATE TABLE fleet_audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  runner_id TEXT,
  lease_id TEXT,
  actor_id TEXT,
  detail_json TEXT NOT NULL
);

CREATE INDEX fleet_audit_ws_idx ON fleet_audit (workspace_id, seq);

CREATE TRIGGER runner_progress_no_update BEFORE UPDATE ON runner_progress
BEGIN SELECT RAISE(ABORT, 'progress is append-only'); END;
CREATE TRIGGER runner_progress_no_delete BEFORE DELETE ON runner_progress
BEGIN SELECT RAISE(ABORT, 'progress is append-only'); END;
CREATE TRIGGER runner_checkpoints_no_update BEFORE UPDATE ON runner_checkpoints
BEGIN SELECT RAISE(ABORT, 'checkpoints are append-only'); END;
CREATE TRIGGER runner_checkpoints_no_delete BEFORE DELETE ON runner_checkpoints
BEGIN SELECT RAISE(ABORT, 'checkpoints are append-only'); END;
CREATE TRIGGER runner_receipts_no_update BEFORE UPDATE ON runner_receipts
BEGIN SELECT RAISE(ABORT, 'receipts are append-only'); END;
CREATE TRIGGER runner_receipts_no_delete BEFORE DELETE ON runner_receipts
BEGIN SELECT RAISE(ABORT, 'receipts are append-only'); END;
CREATE TRIGGER fleet_audit_no_update BEFORE UPDATE ON fleet_audit
BEGIN SELECT RAISE(ABORT, 'the audit is append-only'); END;
CREATE TRIGGER fleet_audit_no_delete BEFORE DELETE ON fleet_audit
BEGIN SELECT RAISE(ABORT, 'the audit is append-only'); END;
