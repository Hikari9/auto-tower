-- Auto-Office adapter: an integrated verification reported as passed with no tests run, or with no
-- commit, is stored as 'unproven'. It proves nothing on high risk. 0005 is already applied in any
-- database that ran it, so it is not edited. SQLite cannot change a CHECK in place, so the table is
-- rebuilt, its rows copied across, and the triggers and indexes of 0005 are created again.

CREATE TABLE office_receipts_next (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  receipt_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  packet_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
  self_verification TEXT NOT NULL CHECK (self_verification IN ('passed', 'failed', 'absent')),
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

INSERT INTO office_receipts_next (
  workspace_id, receipt_id, mission_id, packet_id, attempt_id, outcome, self_verification,
  independent_review, reviewer_id, integrated_verification, failure_class, recorded_at
)
SELECT
  workspace_id, receipt_id, mission_id, packet_id, attempt_id, outcome, self_verification,
  independent_review, reviewer_id, integrated_verification, failure_class, recorded_at
FROM office_receipts;

DROP TABLE office_receipts;
ALTER TABLE office_receipts_next RENAME TO office_receipts;

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
