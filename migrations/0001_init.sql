-- Auto Tower schema v1.
-- Concurrency model: every aggregate is an event stream. A write appends an event
-- with stream_version = expected + 1; the UNIQUE constraint on events rejects a
-- stale writer and the surrounding atomic batch rolls back its projection updates.

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  policy_version INTEGER NOT NULL DEFAULT 0,
  halted INTEGER NOT NULL DEFAULT 0,
  settings_json TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE principals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  kind TEXT NOT NULL CHECK (kind IN ('human','chief','runner','provider','system')),
  name TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  token_hash TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE missions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  parent_id TEXT REFERENCES missions(id),
  title TEXT NOT NULL,
  intent TEXT NOT NULL,
  outcome TEXT NOT NULL,
  constraints_json TEXT NOT NULL DEFAULT '[]',
  risks_json TEXT NOT NULL DEFAULT '[]',
  risk TEXT NOT NULL CHECK (risk IN ('low','medium','high','critical')),
  size TEXT NOT NULL DEFAULT 'm',
  dod_json TEXT NOT NULL DEFAULT '[]',
  acceptance_json TEXT NOT NULL DEFAULT '[]',
  authority_json TEXT NOT NULL DEFAULT '{"actions":[],"resources":[]}',
  priority INTEGER NOT NULL DEFAULT 50,
  source TEXT NOT NULL DEFAULT 'api',
  created_by TEXT NOT NULL,
  state TEXT NOT NULL,
  activity TEXT NOT NULL DEFAULT 'planning',
  blockers_json TEXT NOT NULL DEFAULT '[]',
  depends_on_json TEXT NOT NULL DEFAULT '[]',
  verification_json TEXT,
  discrepancies_json TEXT NOT NULL DEFAULT '[]',
  policy_version_ref INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX missions_ws_state ON missions(workspace_id, state);
CREATE INDEX missions_parent ON missions(parent_id);

CREATE TABLE packets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  acceptance_json TEXT NOT NULL DEFAULT '[]',
  engine TEXT NOT NULL DEFAULT 'auto-office',
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  risk TEXT NOT NULL,
  review_required INTEGER NOT NULL DEFAULT 0,
  depends_on_json TEXT NOT NULL DEFAULT '[]',
  kind TEXT NOT NULL DEFAULT 'work' CHECK (kind IN ('work','integration')),
  origin TEXT NOT NULL DEFAULT 'planned',
  state TEXT NOT NULL,
  hold_reason TEXT,
  blocked_by_json TEXT NOT NULL DEFAULT '[]',
  exec_scope TEXT NOT NULL,
  current_attempt_id TEXT,
  attempts_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_eligible_at TEXT,
  checkpoint_json TEXT,
  result_json TEXT,
  gate_json TEXT,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX packets_mission ON packets(mission_id);
CREATE INDEX packets_ws_state ON packets(workspace_id, state);

CREATE TABLE attempts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  packet_id TEXT NOT NULL REFERENCES packets(id),
  mission_id TEXT NOT NULL,
  runner_id TEXT NOT NULL,
  exec_scope TEXT NOT NULL,
  fence INTEGER NOT NULL,
  lease_expires_at TEXT NOT NULL,
  state TEXT NOT NULL,
  contract_json TEXT NOT NULL,
  local_run_id TEXT,
  phase TEXT,
  checkpoint_json TEXT,
  receipt_json TEXT,
  failure_class TEXT,
  failure_detail TEXT,
  control TEXT,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX attempts_runner ON attempts(runner_id, state);
CREATE INDEX attempts_packet ON attempts(packet_id);

-- One row per mutable execution scope (e.g. a repo branch). holder_attempt_id is
-- the only attempt that may write; fence increases on every new holder.
CREATE TABLE scope_locks (
  exec_scope TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  holder_attempt_id TEXT,
  fence INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

CREATE TABLE runners (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  principal_id TEXT NOT NULL UNIQUE REFERENCES principals(id),
  name TEXT NOT NULL,
  client_version TEXT,
  platform TEXT,
  engines_json TEXT NOT NULL DEFAULT '[]',
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  allowed_scopes_json TEXT NOT NULL DEFAULT '[]',
  max_concurrency INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'offline' CHECK (status IN ('online','offline','quarantined','draining')),
  quarantine_reason TEXT,
  last_seen_at TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE decisions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  category TEXT NOT NULL,
  urgency TEXT NOT NULL CHECK (urgency IN ('low','normal','high','urgent')),
  audience TEXT NOT NULL CHECK (audience IN ('chief','human')),
  question TEXT NOT NULL,
  alternatives_json TEXT NOT NULL DEFAULT '[]',
  recommendation_json TEXT,
  consequences TEXT NOT NULL DEFAULT '',
  required_authority_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  affected_scope TEXT NOT NULL DEFAULT '',
  on_approve_json TEXT NOT NULL DEFAULT '{}',
  dedupe_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','answered','withdrawn')),
  answer_json TEXT,
  answered_by TEXT,
  answered_at TEXT,
  rule_ref_json TEXT,
  version INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX decisions_ws_status ON decisions(workspace_id, status);
CREATE UNIQUE INDEX decisions_open_dedupe ON decisions(workspace_id, dedupe_key) WHERE status = 'open';

CREATE TABLE decision_links (
  decision_id TEXT NOT NULL REFERENCES decisions(id),
  packet_id TEXT NOT NULL,
  PRIMARY KEY (decision_id, packet_id)
);

-- Explicit authority. Rows are immutable except status/revocation; amending a rule
-- creates a new row that supersedes the old one. Every change bumps workspaces.policy_version.
CREATE TABLE policy_rules (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('allow','deny')),
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  grantee TEXT NOT NULL CHECK (grantee IN ('chief','runner','tower','any')),
  conditions_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('active','revoked')),
  expires_at TEXT,
  uses INTEGER NOT NULL DEFAULT 0,
  supersedes TEXT,
  source TEXT NOT NULL DEFAULT 'explicit',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_policy_version INTEGER NOT NULL,
  revoked_by TEXT,
  revoked_at TEXT,
  note TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX policy_rules_ws ON policy_rules(workspace_id, status);

-- Learned, non-authoritative signals. Never read by the policy evaluator.
CREATE TABLE preferences (
  workspace_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  observed_count INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, key)
);

CREATE TABLE rule_proposals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  pattern_key TEXT NOT NULL,
  proposed_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','declined')),
  resolved_rule_id TEXT,
  resolved_by TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX rule_proposals_pending ON rule_proposals(workspace_id, pattern_key) WHERE status = 'pending';

CREATE TABLE issue_links (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  mission_id TEXT NOT NULL REFERENCES missions(id),
  url TEXT NOT NULL,
  provider TEXT NOT NULL,
  external_ref TEXT,
  role TEXT NOT NULL CHECK (role IN ('required','optional','reference')),
  title_snapshot TEXT,
  description_snapshot TEXT,
  observed_state TEXT NOT NULL DEFAULT 'unknown',
  observed_at TEXT,
  observed_source TEXT,
  exemption_json TEXT,
  last_error TEXT,
  error_count INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (mission_id, url)
);
CREATE INDEX issue_links_ref ON issue_links(workspace_id, external_ref);

CREATE TABLE integrations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  config_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, provider)
);

CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  packet_id TEXT,
  attempt_id TEXT,
  kind TEXT NOT NULL,
  summary TEXT NOT NULL,
  uri TEXT,
  sha TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX evidence_mission ON evidence(mission_id);

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  workspace_id TEXT NOT NULL,
  stream_type TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  stream_version INTEGER NOT NULL,
  type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  mission_id TEXT,
  policy_json TEXT,
  evidence_ref TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  UNIQUE (stream_type, stream_id, stream_version)
);
CREATE INDEX events_mission ON events(mission_id, seq);
CREATE INDEX events_ws ON events(workspace_id, seq);

CREATE TABLE idempotency (
  workspace_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, principal_id, key)
);

CREATE TABLE webhook_deliveries (
  provider TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (provider, delivery_id)
);

CREATE TABLE flags (
  workspace_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, key)
);

CREATE TABLE health (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
