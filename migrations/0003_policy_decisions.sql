-- Policy store, preferences, grant proposals and the Decision Inbox.
--
-- Authority changes and decision changes are appended to the `events` log first. These tables are
-- a queryable projection of those events, written in the same transaction and rebuildable by
-- replaying the `policy`, `preferences` and `decision:<id>` streams. Receipts of denied guarded
-- effects are evidence rather than state, so they live in their own append-only table.
-- Plain SQL only so the file can later run on D1.

-- Policy version of a workspace. It moves only when an event can change an evaluation.
CREATE TABLE policy_state (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
  version INTEGER NOT NULL CHECK (version >= 0)
);

-- Grants (effect allow) and deny rules. A row is the current version of the rule; every earlier
-- version is in the `policy` event stream. Revoked and expired rules stay for audit.
CREATE TABLE policy_rules (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  id TEXT NOT NULL,
  -- Version of this rule. Moves on every amendment and on revocation.
  version INTEGER NOT NULL CHECK (version >= 1),
  -- Global `events.seq` of the creating event. Gives evaluation a stable order.
  created_seq INTEGER NOT NULL,
  effect TEXT NOT NULL CHECK (effect IN ('allow', 'deny')),
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  max_risk TEXT NOT NULL CHECK (max_risk IN ('low', 'medium', 'high')),
  grantee_kind TEXT CHECK (grantee_kind IN ('human', 'chief_of_staff', 'runner', 'provider_adapter')),
  grantee_principal_id TEXT,
  limits_json TEXT NOT NULL,
  note TEXT,
  expires_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by TEXT,
  revoke_reason TEXT,
  source_proposal_id TEXT,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (created_by, workspace_id) REFERENCES principals (id, workspace_id),
  FOREIGN KEY (updated_by, workspace_id) REFERENCES principals (id, workspace_id),
  FOREIGN KEY (revoked_by, workspace_id) REFERENCES principals (id, workspace_id),
  FOREIGN KEY (grantee_principal_id, workspace_id) REFERENCES principals (id, workspace_id),
  -- A grant always names who holds it. Only a deny rule may apply to everyone.
  CHECK (effect = 'deny' OR grantee_kind IS NOT NULL OR grantee_principal_id IS NOT NULL)
);

CREATE INDEX policy_rules_workspace_idx ON policy_rules (workspace_id, created_seq);

-- Preferences: observed or stated, and never read by an evaluation.
CREATE TABLE preferences (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, key),
  FOREIGN KEY (updated_by, workspace_id) REFERENCES principals (id, workspace_id)
);

-- A human approved one decision whose request is described by a signature.
-- Repeats of one signature produce a pending proposal and nothing else.
CREATE TABLE approval_observations (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  decision_id TEXT NOT NULL,
  signature TEXT NOT NULL,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  risk TEXT NOT NULL CHECK (risk IN ('low', 'medium', 'high')),
  amount INTEGER,
  approved_by TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  -- Set when a later answer to the same decision replaced the approval.
  withdrawn_at TEXT,
  PRIMARY KEY (workspace_id, decision_id),
  FOREIGN KEY (approved_by, workspace_id) REFERENCES principals (id, workspace_id)
);

CREATE INDEX approval_observations_signature_idx ON approval_observations (workspace_id, signature);

CREATE TABLE policy_proposals (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'narrowed', 'declined')),
  signature TEXT NOT NULL,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  max_risk TEXT NOT NULL CHECK (max_risk IN ('low', 'medium', 'high')),
  grantee_kind TEXT NOT NULL CHECK (grantee_kind IN ('human', 'chief_of_staff', 'runner', 'provider_adapter')),
  limits_json TEXT NOT NULL,
  -- Decision ids whose approvals led to this proposal.
  evidence_json TEXT NOT NULL,
  approvals INTEGER NOT NULL CHECK (approvals >= 1),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT,
  resolution_note TEXT,
  resulting_rule_id TEXT,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (resolved_by, workspace_id) REFERENCES principals (id, workspace_id)
);

-- At most one open proposal for a request signature.
CREATE UNIQUE INDEX policy_proposals_pending_idx ON policy_proposals (workspace_id, signature) WHERE status = 'pending';
CREATE INDEX policy_proposals_status_idx ON policy_proposals (workspace_id, status);

-- Evidence that a guarded effect was refused or sent to a person. Append-only.
CREATE TABLE policy_receipts (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  principal_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource TEXT NOT NULL,
  scope TEXT NOT NULL,
  risk TEXT NOT NULL CHECK (risk IN ('low', 'medium', 'high')),
  amount INTEGER,
  mission_id TEXT,
  effect TEXT NOT NULL CHECK (effect IN ('deny', 'escalate')),
  code TEXT NOT NULL,
  reason TEXT NOT NULL,
  rule_id TEXT,
  rule_version INTEGER,
  policy_version INTEGER NOT NULL,
  evaluated_at TEXT NOT NULL,
  FOREIGN KEY (principal_id, workspace_id) REFERENCES principals (id, workspace_id)
);

CREATE INDEX policy_receipts_workspace_idx ON policy_receipts (workspace_id, seq);

CREATE TRIGGER policy_receipts_no_update BEFORE UPDATE ON policy_receipts
BEGIN
  SELECT RAISE(ABORT, 'policy receipts are append-only');
END;

CREATE TRIGGER policy_receipts_no_delete BEFORE DELETE ON policy_receipts
BEGIN
  SELECT RAISE(ABORT, 'policy receipts are append-only');
END;

-- Decision Inbox. One item can block several branches, which are linked in `decision_links`.
CREATE TABLE decisions (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  id TEXT NOT NULL,
  -- Version of the `decision:<id>` event stream this row was projected from.
  version INTEGER NOT NULL CHECK (version >= 1),
  created_seq INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'answered')),
  dedupe_key TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN (
    'scope_expansion', 'sensitive_action', 'destructive', 'spend', 'security',
    'production', 'novel', 'clarification'
  )),
  urgency TEXT NOT NULL CHECK (urgency IN ('low', 'normal', 'high', 'urgent')),
  question TEXT NOT NULL,
  alternatives_json TEXT NOT NULL,
  recommendation_json TEXT,
  consequences TEXT NOT NULL,
  required_authority TEXT NOT NULL CHECK (required_authority IN ('human', 'chief_of_staff')),
  evidence_json TEXT NOT NULL,
  affected_scope_json TEXT NOT NULL,
  -- The structured action request the answer would authorize, when there is one.
  request_json TEXT,
  -- Confidence and other claims by the requester. Shown to the answerer, never evaluated.
  advisory_json TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- The answer with the highest version, which decides the outcome.
  effective_answer_version INTEGER,
  effective_choice TEXT,
  answered_by TEXT,
  answered_at TEXT,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (created_by, workspace_id) REFERENCES principals (id, workspace_id),
  FOREIGN KEY (answered_by, workspace_id) REFERENCES principals (id, workspace_id)
);

-- One open item per dedupe key. An answered item no longer absorbs new requests.
CREATE UNIQUE INDEX decisions_open_dedupe_idx ON decisions (workspace_id, dedupe_key) WHERE status = 'open';
CREATE INDEX decisions_inbox_idx ON decisions (workspace_id, status, urgency, created_seq);

CREATE TABLE decision_links (
  workspace_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  -- Empty for a link to the mission as a whole.
  packet_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('blocked', 'resumed', 'declined', 'skipped')),
  reason TEXT,
  linked_at TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by_answer_version INTEGER,
  PRIMARY KEY (workspace_id, decision_id, mission_id, packet_id),
  FOREIGN KEY (workspace_id, decision_id) REFERENCES decisions (workspace_id, id),
  FOREIGN KEY (workspace_id, mission_id) REFERENCES missions (workspace_id, id)
);

CREATE INDEX decision_links_branch_idx ON decision_links (workspace_id, mission_id, packet_id);

-- Every answer ever received. The one with the highest version is effective, whatever order they arrived in.
CREATE TABLE decision_answers (
  workspace_id TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  choice TEXT NOT NULL,
  note TEXT,
  answered_by TEXT NOT NULL,
  answered_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, decision_id, version),
  FOREIGN KEY (workspace_id, decision_id) REFERENCES decisions (workspace_id, id),
  FOREIGN KEY (answered_by, workspace_id) REFERENCES principals (id, workspace_id)
);

CREATE TRIGGER decision_answers_no_update BEFORE UPDATE ON decision_answers
BEGIN
  SELECT RAISE(ABORT, 'decision answers are append-only');
END;

CREATE TRIGGER decision_answers_no_delete BEFORE DELETE ON decision_answers
BEGIN
  SELECT RAISE(ABORT, 'decision answers are append-only');
END;
