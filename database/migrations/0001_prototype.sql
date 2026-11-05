-- Isolated local/staging prototype only. No production bindings or data.
PRAGMA foreign_keys = ON;

CREATE TABLE system_control (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  environment TEXT NOT NULL CHECK (environment IN ('local', 'staging')),
  generation INTEGER NOT NULL CHECK (generation > 0),
  accepting_commands INTEGER NOT NULL DEFAULT 0 CHECK (accepting_commands IN (0, 1))
);
CREATE TABLE people (
  person_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL
);
CREATE TABLE principals (
  principal_id TEXT PRIMARY KEY,
  person_id TEXT REFERENCES people(person_id),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);
CREATE TABLE organizational_units (
  unit_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  roster_version INTEGER NOT NULL CHECK (roster_version > 0)
);
CREATE TABLE memberships (
  person_id TEXT NOT NULL REFERENCES people(person_id),
  unit_id TEXT NOT NULL REFERENCES organizational_units(unit_id),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  PRIMARY KEY (person_id, unit_id)
);
CREATE INDEX memberships_unit_active ON memberships(unit_id, active, person_id);
CREATE TABLE events (
  event_id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
);
CREATE TABLE event_units (
  event_id TEXT NOT NULL REFERENCES events(event_id),
  unit_id TEXT NOT NULL REFERENCES organizational_units(unit_id),
  PRIMARY KEY (event_id, unit_id)
);
CREATE TABLE access_grants (
  principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  capability TEXT NOT NULL CHECK (capability IN ('attendance.report', 'excusal.submit', 'excusal.decide')),
  unit_id TEXT NOT NULL REFERENCES organizational_units(unit_id),
  subject_scope TEXT NOT NULL CHECK (subject_scope IN ('self', 'unit')),
  PRIMARY KEY (principal_id, capability, unit_id)
);
CREATE TABLE adapter_sources (
  source_kind TEXT NOT NULL CHECK (source_kind IN ('form', 'sheet', 'test')),
  resource_key TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  PRIMARY KEY (source_kind, resource_key)
);
CREATE TABLE operation_commands (
  command_id TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES principals(principal_id),
  operation TEXT NOT NULL,
  unit_id TEXT NOT NULL REFERENCES organizational_units(unit_id),
  event_id TEXT NOT NULL REFERENCES events(event_id),
  target_person_id TEXT REFERENCES people(person_id),
  source_kind TEXT NOT NULL,
  source_resource TEXT NOT NULL,
  source_submission TEXT NOT NULL,
  source_revision INTEGER NOT NULL,
  accepted_at TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  UNIQUE (source_kind, source_resource, source_submission, source_revision, operation)
);
-- Inserting a failed assertion aborts the entire D1 batch, including earlier writes.
CREATE TABLE command_assertions (
  command_id TEXT PRIMARY KEY,
  ok INTEGER NOT NULL CONSTRAINT command_preconditions CHECK (ok = 1)
);
CREATE TABLE attendance_reports (
  report_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(event_id),
  unit_id TEXT NOT NULL REFERENCES organizational_units(unit_id),
  roster_version INTEGER NOT NULL,
  completeness TEXT NOT NULL CHECK (completeness IN ('partial', 'complete')),
  submitted_at TEXT NOT NULL,
  submitted_by TEXT NOT NULL REFERENCES principals(principal_id),
  command_id TEXT NOT NULL UNIQUE REFERENCES operation_commands(command_id)
);
CREATE TABLE attendance_report_members (
  report_id TEXT NOT NULL REFERENCES attendance_reports(report_id),
  person_id TEXT NOT NULL REFERENCES people(person_id),
  present INTEGER NOT NULL CHECK (present IN (0, 1)),
  PRIMARY KEY (report_id, person_id)
);
CREATE TABLE attendance_observations (
  observation_id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id TEXT NOT NULL REFERENCES attendance_reports(report_id),
  event_id TEXT NOT NULL REFERENCES events(event_id),
  person_id TEXT NOT NULL REFERENCES people(person_id),
  code TEXT NOT NULL CHECK (code = 'P'),
  accepted_at TEXT NOT NULL,
  UNIQUE (report_id, person_id)
);
CREATE INDEX observations_pair ON attendance_observations(event_id, person_id, observation_id);
CREATE TABLE attendance_current (
  event_id TEXT NOT NULL REFERENCES events(event_id),
  person_id TEXT NOT NULL REFERENCES people(person_id),
  observed_code TEXT NOT NULL CHECK (observed_code = 'P'),
  version INTEGER NOT NULL CHECK (version > 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (event_id, person_id)
);
CREATE TABLE excusal_requests (
  request_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(event_id),
  person_id TEXT NOT NULL REFERENCES people(person_id),
  unit_id TEXT NOT NULL REFERENCES organizational_units(unit_id),
  requested_outcome TEXT NOT NULL CHECK (requested_outcome IN ('P', 'T', 'E', 'ES', 'MED')),
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('Submitted', 'Approved', 'Denied', 'Withdrawn', 'Superseded')),
  decision TEXT CHECK (decision IN ('Approved', 'Denied', 'Withdrawn', 'Superseded')),
  version INTEGER NOT NULL CHECK (version > 0),
  submitted_at TEXT NOT NULL,
  submitted_by TEXT NOT NULL REFERENCES principals(principal_id),
  updated_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT REFERENCES principals(principal_id),
  decision_reason TEXT,
  source_json TEXT NOT NULL,
  command_id TEXT NOT NULL REFERENCES operation_commands(command_id),
  last_command_id TEXT NOT NULL REFERENCES operation_commands(command_id)
);
CREATE INDEX requests_pair ON excusal_requests(event_id, person_id, request_id);
CREATE TABLE excusal_decisions (
  request_id TEXT NOT NULL REFERENCES excusal_requests(request_id),
  version INTEGER NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor_id TEXT NOT NULL REFERENCES principals(principal_id),
  accepted_at TEXT NOT NULL,
  command_id TEXT NOT NULL UNIQUE REFERENCES operation_commands(command_id),
  PRIMARY KEY (request_id, version)
);
CREATE TABLE audit_events (
  audit_id INTEGER PRIMARY KEY AUTOINCREMENT,
  command_id TEXT NOT NULL UNIQUE REFERENCES operation_commands(command_id),
  actor_id TEXT NOT NULL REFERENCES principals(principal_id),
  actor_evidence TEXT NOT NULL,
  operation TEXT NOT NULL,
  target_id TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  metadata_json TEXT NOT NULL
);
CREATE TABLE outbox_jobs (
  job_id TEXT PRIMARY KEY,
  command_id TEXT NOT NULL REFERENCES operation_commands(command_id),
  kind TEXT NOT NULL CHECK (kind = 'attendance.projection'),
  event_id TEXT NOT NULL REFERENCES events(event_id),
  unit_id TEXT NOT NULL REFERENCES organizational_units(unit_id),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'leased', 'done')),
  created_at TEXT NOT NULL,
  worker_id TEXT,
  claim_token TEXT,
  lease_expires_at TEXT,
  completed_at TEXT
);
CREATE INDEX outbox_pending ON outbox_jobs(state, created_at, job_id);
CREATE INDEX outbox_resource ON outbox_jobs(event_id, unit_id, state);
