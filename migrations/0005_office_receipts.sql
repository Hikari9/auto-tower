-- Auto-Office adapter: one ingested receipt per attempt, storing the verdict facts Tower judged from
-- it. Only facts and identifiers are kept. Free text from the engine (summaries, residual risks,
-- evidence) is not stored here, so this table holds no secret-bearing text. Plain SQL only so the
-- file can later run on D1.
--
-- Rows are append-only. Completion is decided at read time from these facts and the mission's
-- current risk, so a later risk change is judged on the same evidence.

CREATE TABLE office_receipts (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  receipt_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  packet_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
  -- The engine's own check. It never counts as independent review.
  self_verification TEXT NOT NULL CHECK (self_verification IN ('passed', 'failed', 'absent')),
  -- `self-reviewed`: the reviewer identity equalled a producer identity, so it does not count.
  independent_review TEXT NOT NULL CHECK (independent_review IN ('satisfied', 'self-reviewed', 'rejected', 'missing')),
  reviewer_id TEXT,
  integrated_verification TEXT NOT NULL CHECK (integrated_verification IN ('passed', 'failed', 'absent', 'unproven')),
  failure_class TEXT CHECK (failure_class IS NULL OR failure_class IN (
    'environment', 'runner', 'adapter', 'quota', 'policy-denial', 'review-failure', 'implementation-defect'
  )),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, receipt_id),
  CHECK (outcome = 'succeeded' OR failure_class IS NOT NULL)
);

CREATE UNIQUE INDEX office_receipts_one_per_attempt ON office_receipts (workspace_id, attempt_id);
CREATE INDEX office_receipts_by_mission ON office_receipts (workspace_id, mission_id);

CREATE TRIGGER office_receipts_no_update BEFORE UPDATE ON office_receipts
BEGIN
  SELECT RAISE(ABORT, 'office receipts are append-only');
END;

CREATE TRIGGER office_receipts_no_delete BEFORE DELETE ON office_receipts
BEGIN
  SELECT RAISE(ABORT, 'office receipts are append-only');
END;
