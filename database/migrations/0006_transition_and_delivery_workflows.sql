-- Additive durable workflows; applied migrations 0001–0005 are immutable.
CREATE TABLE transition_authorities (
  principal_id TEXT PRIMARY KEY REFERENCES principals(principal_id),
  active INTEGER NOT NULL CHECK(active IN (0,1))
);
CREATE TABLE term_transitions (
  transition_id TEXT PRIMARY KEY, source_term_id TEXT NOT NULL REFERENCES terms(term_id),
  target_term_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('semester','academic-year')),
  version INTEGER NOT NULL CHECK(version>0),
  state TEXT NOT NULL CHECK(state IN ('proposed','archiving','ready','publishing','complete','cancelled')),
  plan_json TEXT NOT NULL, plan_hash TEXT NOT NULL, snapshot_json TEXT NOT NULL, snapshot_hash TEXT NOT NULL,
  base_operations_revision INTEGER NOT NULL, base_administration_revision INTEGER NOT NULL,
  prepared_command_id TEXT NOT NULL REFERENCES admin_commands(command_id),
  accepted_command_id TEXT REFERENCES admin_commands(command_id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX term_transition_active_source ON term_transitions(source_term_id)
 WHERE state NOT IN ('complete','cancelled');
CREATE TABLE transition_archive_jobs (
  transition_id TEXT PRIMARY KEY REFERENCES term_transitions(transition_id),
  state TEXT NOT NULL CHECK(state IN ('pending','leased','done')),
  worker_id TEXT, claim_token TEXT, lease_expires_at TEXT,
  snapshot_hash TEXT NOT NULL, receipt_json TEXT, completed_at TEXT,
  claimed_by TEXT REFERENCES principals(principal_id), verified_by TEXT REFERENCES principals(principal_id)
);
CREATE TABLE transition_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT, transition_id TEXT NOT NULL REFERENCES term_transitions(transition_id),
  command_id TEXT NOT NULL UNIQUE REFERENCES admin_commands(command_id),
  action TEXT NOT NULL, version INTEGER NOT NULL, principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  accepted_at TEXT NOT NULL, detail_json TEXT NOT NULL
);
CREATE TABLE transition_people_history (
  transition_id TEXT NOT NULL REFERENCES term_transitions(transition_id), person_id TEXT NOT NULL REFERENCES people(person_id),
  previous_version INTEGER NOT NULL, version INTEGER NOT NULL,
  before_json TEXT NOT NULL, after_json TEXT NOT NULL,
  PRIMARY KEY(transition_id,person_id)
);
CREATE TABLE notification_delivery_claims (
  claim_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE REFERENCES notification_attempts(attempt_id),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id), worker_id TEXT NOT NULL,
  claim_token TEXT NOT NULL, message_json TEXT NOT NULL, completion_hash TEXT, receipt_json TEXT
);
CREATE TABLE notification_tasks (
  task_id TEXT PRIMARY KEY, source_command_id TEXT NOT NULL REFERENCES command_registry(command_id),
  request_id TEXT NOT NULL REFERENCES excusal_requests(request_id), request_version INTEGER NOT NULL CHECK(request_version>0),
  request_json TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','done')),
  mode TEXT NOT NULL CHECK(mode='suppressed'), created_at TEXT NOT NULL, completed_at TEXT,
  planning_command_id TEXT REFERENCES admin_commands(command_id),
  UNIQUE(request_id,request_version)
);
CREATE INDEX notification_tasks_pending ON notification_tasks(state,created_at,task_id);
CREATE TABLE transition_archive_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT, transition_id TEXT NOT NULL REFERENCES term_transitions(transition_id),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id), worker_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('claimed','verified')), accepted_at TEXT NOT NULL, snapshot_hash TEXT NOT NULL
);
