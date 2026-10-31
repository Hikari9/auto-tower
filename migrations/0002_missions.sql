-- Mission, work packet and execution attempt projections.
--
-- The `events` table is the source of truth. These tables are a queryable projection of it,
-- written in the same transaction as each appended event and rebuildable by replaying the stream.
-- Unlike `events` they are updated in place. Plain SQL only so the file can later run on D1.

CREATE TABLE missions (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  id TEXT NOT NULL,
  -- Version of the mission stream this row was projected from.
  version INTEGER NOT NULL CHECK (version >= 1),
  -- Global `events.seq` of the creating event. Gives the scheduler a stable tie-break.
  created_seq INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'draft', 'planning', 'ready', 'running', 'waiting-runner', 'waiting-decision',
    'waiting-external', 'verifying', 'reconciling', 'completed', 'needs-attention', 'cancelled'
  )),
  title TEXT NOT NULL,
  intent TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  risk TEXT NOT NULL CHECK (risk IN ('low', 'medium', 'high')),
  size TEXT NOT NULL CHECK (size IN ('xs', 's', 'm', 'l', 'xl')),
  parent_id TEXT,
  required_for_parent INTEGER NOT NULL CHECK (required_for_parent IN (0, 1)),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  cancelled_at TEXT,
  -- Full current state as JSON. Reads serve this; the columns above exist for search and scheduling.
  snapshot_json TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (created_by, workspace_id) REFERENCES principals (id, workspace_id),
  -- A parent must live in the same workspace.
  FOREIGN KEY (workspace_id, parent_id) REFERENCES missions (workspace_id, id),
  CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE INDEX missions_state_idx ON missions (workspace_id, state);
CREATE INDEX missions_parent_idx ON missions (workspace_id, parent_id);
CREATE INDEX missions_updated_idx ON missions (workspace_id, updated_at);

CREATE TABLE work_packets (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position >= 1),
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'pending', 'ready', 'leased', 'running', 'reported', 'verified', 'failed', 'cancelled'
  )),
  required INTEGER NOT NULL CHECK (required IN (0, 1)),
  authorized_at TEXT,
  authorized_by TEXT,
  verified_at TEXT,
  verified_by TEXT,
  active_attempt_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, mission_id, position),
  FOREIGN KEY (workspace_id, mission_id) REFERENCES missions (workspace_id, id)
);

CREATE INDEX work_packets_mission_idx ON work_packets (workspace_id, mission_id);
CREATE INDEX work_packets_status_idx ON work_packets (workspace_id, status);

-- Edges of the dependency graph. A packet starts only when every packet it depends on is verified.
CREATE TABLE packet_dependencies (
  workspace_id TEXT NOT NULL,
  packet_id TEXT NOT NULL,
  depends_on_packet_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, packet_id, depends_on_packet_id),
  FOREIGN KEY (workspace_id, packet_id) REFERENCES work_packets (workspace_id, id),
  FOREIGN KEY (workspace_id, depends_on_packet_id) REFERENCES work_packets (workspace_id, id),
  CHECK (packet_id <> depends_on_packet_id)
);

CREATE INDEX packet_dependencies_target_idx ON packet_dependencies (workspace_id, depends_on_packet_id);

-- One try at a work packet. `self-reported-*` is what the runner claimed, not what Tower verified.
CREATE TABLE execution_attempts (
  workspace_id TEXT NOT NULL,
  id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  packet_id TEXT NOT NULL,
  number INTEGER NOT NULL CHECK (number >= 1),
  runner_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'leased', 'running', 'self-reported-succeeded', 'self-reported-failed', 'cancelled'
  )),
  dispatched_at TEXT NOT NULL,
  started_at TEXT,
  reported_at TEXT,
  reported_by TEXT,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, packet_id, number),
  FOREIGN KEY (workspace_id, packet_id) REFERENCES work_packets (workspace_id, id),
  FOREIGN KEY (workspace_id, mission_id) REFERENCES missions (workspace_id, id)
);

CREATE INDEX execution_attempts_packet_idx ON execution_attempts (workspace_id, packet_id);
CREATE INDEX execution_attempts_runner_idx ON execution_attempts (workspace_id, runner_id, status);
