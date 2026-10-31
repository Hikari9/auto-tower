-- MCP endpoint, OAuth identity links and feature flags. Plain SQL only so the file can later run on D1.
--
-- Nothing here holds a bearer token, an authorization code or a client secret. Sessions, replayed
-- results and audit rows name principals and tools, never credentials.

-- One row per MCP session. A session is bound to the principal that opened it and is refused for
-- any other. It lives in the database so a restart does not end it.
CREATE TABLE mcp_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  principal_id TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  client_name TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  closed_at TEXT,
  FOREIGN KEY (principal_id, workspace_id) REFERENCES principals (id, workspace_id)
);

CREATE INDEX mcp_sessions_principal_idx ON mcp_sessions (workspace_id, principal_id, created_at);

-- First result of each mutating tool call, so a retry with the same key returns it instead of
-- acting twice. The same key with another tool or other arguments is refused. Scoped to the caller.
CREATE TABLE mcp_idempotency (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  principal_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  tool TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, principal_id, idempotency_key),
  FOREIGN KEY (principal_id, workspace_id) REFERENCES principals (id, workspace_id)
);

-- Every tool call and its outcome, with no arguments and no result. Append only.
CREATE TABLE mcp_audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  principal_id TEXT NOT NULL,
  session_id TEXT,
  tool TEXT NOT NULL,
  mutating INTEGER NOT NULL CHECK (mutating IN (0, 1)),
  outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'replayed', 'refused', 'error')),
  error_code TEXT,
  recorded_at TEXT NOT NULL,
  FOREIGN KEY (principal_id, workspace_id) REFERENCES principals (id, workspace_id)
);

CREATE INDEX mcp_audit_workspace_idx ON mcp_audit (workspace_id, seq);

CREATE TRIGGER mcp_audit_no_update BEFORE UPDATE ON mcp_audit
BEGIN
  SELECT RAISE(ABORT, 'mcp audit rows are append-only');
END;

CREATE TRIGGER mcp_audit_no_delete BEFORE DELETE ON mcp_audit
BEGIN
  SELECT RAISE(ABORT, 'mcp audit rows are append-only');
END;

-- Which Tower principal an identity from the external provider acts as. A human links it. The
-- scopes are a ceiling for tokens that identity presents, and are cut again by the principal kind.
-- Without a row, a valid provider token still authenticates nobody.
CREATE TABLE oauth_identities (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  linked_by TEXT NOT NULL,
  linked_at TEXT NOT NULL,
  revoked_at TEXT,
  PRIMARY KEY (issuer, subject),
  FOREIGN KEY (principal_id, workspace_id) REFERENCES principals (id, workspace_id),
  FOREIGN KEY (linked_by, workspace_id) REFERENCES principals (id, workspace_id)
);

CREATE INDEX oauth_identities_principal_idx ON oauth_identities (workspace_id, principal_id);

-- Feature flags. A row exists only once someone tried to turn a flag on, so no row means off.
-- Whether a flag is in effect is decided at read time from this row, the approved provider list
-- and the policy store, so revoking the policy turns the flag off without touching this row.
CREATE TABLE feature_flags (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  flag TEXT NOT NULL CHECK (flag IN ('cloud_ai.triage', 'hosted_execution')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  provider_id TEXT,
  budget_cents INTEGER CHECK (budget_cents IS NULL OR budget_cents > 0),
  policy_rule_id TEXT,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, flag),
  FOREIGN KEY (updated_by, workspace_id) REFERENCES principals (id, workspace_id),
  -- A flag that is on names the provider and the budget it was approved with.
  CHECK (enabled = 0 OR (provider_id IS NOT NULL AND budget_cents IS NOT NULL AND policy_rule_id IS NOT NULL))
);
