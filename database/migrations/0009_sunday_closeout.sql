-- Explicit unattended authority; no principal is enrolled by migration.
CREATE TABLE closeout_authorities (
  principal_id TEXT PRIMARY KEY REFERENCES principals(principal_id), active INTEGER NOT NULL CHECK(active IN (0,1))
);
CREATE TABLE attendance_closeouts (
  closeout_id TEXT PRIMARY KEY, environment TEXT NOT NULL CHECK(environment IN ('local','staging')),
  generation INTEGER NOT NULL, policy_version TEXT NOT NULL, as_of TEXT NOT NULL,
  window_start TEXT NOT NULL, window_end TEXT NOT NULL, term_id TEXT NOT NULL REFERENCES terms(term_id),
  version INTEGER NOT NULL CHECK(version>0), state TEXT NOT NULL CHECK(state IN ('processing','notifying','complete','needs-review')),
  source_kind TEXT NOT NULL, source_resource TEXT NOT NULL,
  prepared_command_id TEXT NOT NULL UNIQUE REFERENCES admin_commands(command_id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(environment,generation,policy_version,window_end)
);
CREATE TABLE closeout_items (
  closeout_id TEXT NOT NULL REFERENCES attendance_closeouts(closeout_id), event_id TEXT NOT NULL REFERENCES events(event_id),
  person_id TEXT NOT NULL REFERENCES people(person_id), event_version INTEGER NOT NULL, flight_id TEXT NOT NULL REFERENCES organizational_units(unit_id),
  state TEXT NOT NULL CHECK(state IN ('pending','completed','preserved','needs-review')),
  before_code TEXT, final_code TEXT, reason TEXT, command_id TEXT REFERENCES operation_commands(command_id),
  PRIMARY KEY(closeout_id,event_id,person_id)
);
CREATE INDEX closeout_items_pending ON closeout_items(closeout_id,state,event_id,person_id);
CREATE TABLE closeout_steps (
  closeout_id TEXT NOT NULL REFERENCES attendance_closeouts(closeout_id),
  base_version INTEGER NOT NULL, command_id TEXT NOT NULL UNIQUE REFERENCES admin_commands(command_id),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id), receipt_json TEXT NOT NULL,
  PRIMARY KEY(closeout_id,base_version)
);
