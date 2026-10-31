-- Tower base schema. Plain SQL only so the same file can later run on Cloudflare D1.
-- Every row that belongs to a tenant carries workspace_id.

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE principals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  kind TEXT NOT NULL CHECK (kind IN ('human', 'chief_of_staff', 'runner', 'provider_adapter')),
  name TEXT NOT NULL,
  disabled_at TEXT,
  created_at TEXT NOT NULL,
  -- Target for composite foreign keys, so a row cannot name a principal from another workspace.
  UNIQUE (id, workspace_id)
);

CREATE INDEX principals_workspace_idx ON principals (workspace_id);

-- Only the SHA-256 of each token is stored; the raw token is shown once at issue time.
CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  principal_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  FOREIGN KEY (principal_id, workspace_id) REFERENCES principals (id, workspace_id)
);

CREATE INDEX api_tokens_principal_idx ON api_tokens (principal_id);

-- Append-only event log. `seq` gives a global order; `version` gives per-stream order
-- and is the target of optimistic concurrency (expected version on append).
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  stream_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  policy_refs_json TEXT NOT NULL DEFAULT '[]',
  evidence_refs_json TEXT NOT NULL DEFAULT '[]',
  recorded_at TEXT NOT NULL,
  UNIQUE (workspace_id, stream_id, version),
  FOREIGN KEY (actor_id, workspace_id) REFERENCES principals (id, workspace_id)
);

-- Idempotency keys are scoped per principal. A replay returns the event the first call wrote.
CREATE TABLE idempotency_keys (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  principal_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  event_seq INTEGER NOT NULL REFERENCES events(seq),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, principal_id, idempotency_key),
  FOREIGN KEY (principal_id, workspace_id) REFERENCES principals (id, workspace_id)
);

CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

-- Delete triggers do not fire for rows removed by INSERT OR REPLACE, so block the
-- conflicting insert itself. BEFORE triggers run before constraint checks.
CREATE TRIGGER events_no_replace BEFORE INSERT ON events
WHEN EXISTS (
    SELECT 1 FROM events e
    WHERE e.workspace_id = NEW.workspace_id AND e.stream_id = NEW.stream_id AND e.version = NEW.version
  )
  OR (NEW.seq IS NOT NULL AND EXISTS (SELECT 1 FROM events e WHERE e.seq = NEW.seq))
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TRIGGER idempotency_keys_no_update BEFORE UPDATE ON idempotency_keys
BEGIN
  SELECT RAISE(ABORT, 'idempotency keys are append-only');
END;

CREATE TRIGGER idempotency_keys_no_delete BEFORE DELETE ON idempotency_keys
BEGIN
  SELECT RAISE(ABORT, 'idempotency keys are append-only');
END;

CREATE TRIGGER idempotency_keys_no_replace BEFORE INSERT ON idempotency_keys
WHEN EXISTS (
  SELECT 1 FROM idempotency_keys k
  WHERE k.workspace_id = NEW.workspace_id AND k.principal_id = NEW.principal_id AND k.idempotency_key = NEW.idempotency_key
)
BEGIN
  SELECT RAISE(ABORT, 'idempotency keys are append-only');
END;
