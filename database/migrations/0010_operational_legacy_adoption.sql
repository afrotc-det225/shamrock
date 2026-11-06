-- Canonical excusal state supports explicit legacy origins without invented human submissions.
-- Earlier request/decision tables remain immutable migration sources; all new runtime IO uses these records.
CREATE TABLE legacy_operational_adoptions (
  adoption_id TEXT PRIMARY KEY, import_run_id TEXT NOT NULL REFERENCES legacy_import_runs(import_run_id),
  evidence_sha256 TEXT NOT NULL, plan_sha256 TEXT NOT NULL, review_reference TEXT NOT NULL,
  source_commit TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('loading','complete')),
  expected_rows INTEGER NOT NULL CHECK(expected_rows>0), expected_contacts INTEGER NOT NULL,
  expected_requests INTEGER NOT NULL, started_at TEXT NOT NULL, completed_at TEXT
);
CREATE TABLE legacy_operational_adoption_rows (
  adoption_id TEXT NOT NULL REFERENCES legacy_operational_adoptions(adoption_id),
  import_run_id TEXT NOT NULL, source_occurrence_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('leadership','excusal')),
  disposition TEXT NOT NULL CHECK(disposition IN ('adopted','retired','quarantined')),
  target_id TEXT, evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  PRIMARY KEY(adoption_id,source_occurrence_id),
  FOREIGN KEY(import_run_id,source_occurrence_id) REFERENCES legacy_source_occurrences(import_run_id,occurrence_id)
);
CREATE INDEX legacy_adoption_targets ON legacy_operational_adoption_rows(kind,target_id);
CREATE TABLE excusal_records (
  request_id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES events(event_id),
  person_id TEXT NOT NULL REFERENCES people(person_id), unit_id TEXT NOT NULL REFERENCES organizational_units(unit_id),
  requested_outcome TEXT NOT NULL CHECK(requested_outcome IN ('P','T','E','ES','MED')), reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('Submitted','Approved','Denied','Withdrawn','Superseded')),
  decision TEXT CHECK(decision IN ('Approved','Denied','Withdrawn','Superseded')),
  version INTEGER NOT NULL CHECK(version>0), submitted_at TEXT NOT NULL,
  submitted_by TEXT REFERENCES principals(principal_id), updated_at TEXT NOT NULL, decided_at TEXT,
  decided_by TEXT REFERENCES principals(principal_id), decision_reason TEXT,
  source_json TEXT NOT NULL CHECK(json_valid(source_json)),
  command_id TEXT REFERENCES operation_commands(command_id), last_command_id TEXT REFERENCES operation_commands(command_id),
  origin TEXT NOT NULL DEFAULT 'native' CHECK(origin IN ('native','legacy')),
  legacy_adoption_id TEXT, legacy_occurrence_id TEXT,
  FOREIGN KEY(legacy_adoption_id,legacy_occurrence_id) REFERENCES legacy_operational_adoption_rows(adoption_id,source_occurrence_id),
  CHECK((origin='native' AND submitted_by IS NOT NULL AND command_id IS NOT NULL AND last_command_id IS NOT NULL AND legacy_adoption_id IS NULL AND legacy_occurrence_id IS NULL)
    OR (origin='legacy' AND legacy_adoption_id IS NOT NULL AND legacy_occurrence_id IS NOT NULL AND command_id IS NULL AND submitted_by IS NULL))
);
CREATE INDEX excusal_records_pair ON excusal_records(event_id,person_id,request_id);
INSERT INTO excusal_records(request_id,event_id,person_id,unit_id,requested_outcome,reason,status,decision,version,submitted_at,submitted_by,updated_at,decided_at,decided_by,decision_reason,source_json,command_id,last_command_id)
  SELECT request_id,event_id,person_id,unit_id,requested_outcome,reason,status,decision,version,submitted_at,submitted_by,updated_at,decided_at,decided_by,decision_reason,source_json,command_id,last_command_id FROM excusal_requests;
CREATE TABLE excusal_record_decisions (
  request_id TEXT NOT NULL REFERENCES excusal_records(request_id), version INTEGER NOT NULL,
  decision TEXT NOT NULL, reason TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES principals(principal_id),
  accepted_at TEXT NOT NULL, command_id TEXT NOT NULL UNIQUE REFERENCES operation_commands(command_id),
  PRIMARY KEY(request_id,version)
);
INSERT INTO excusal_record_decisions SELECT * FROM excusal_decisions;
CREATE UNIQUE INDEX excusal_records_one_event_per_submission ON excusal_records(command_id,event_id);
CREATE TABLE excusal_notification_tasks (
  task_id TEXT PRIMARY KEY, source_command_id TEXT NOT NULL REFERENCES command_registry(command_id),
  request_id TEXT NOT NULL REFERENCES excusal_records(request_id), request_version INTEGER NOT NULL CHECK(request_version>0),
  request_json TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','done')),
  mode TEXT NOT NULL CHECK(mode='suppressed'), created_at TEXT NOT NULL, completed_at TEXT,
  planning_command_id TEXT REFERENCES admin_commands(command_id), UNIQUE(request_id,request_version)
);
CREATE INDEX excusal_notification_tasks_pending ON excusal_notification_tasks(state,created_at,task_id);
INSERT INTO excusal_notification_tasks SELECT * FROM notification_tasks;
