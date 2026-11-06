-- Additive administration schema. Existing command, attendance and excusal rows retain their identities.
CREATE TABLE squadrons (squadron_id TEXT PRIMARY KEY, label TEXT NOT NULL UNIQUE);
CREATE TABLE flight_hierarchy (
  unit_id TEXT PRIMARY KEY REFERENCES organizational_units(unit_id),
  squadron_id TEXT NOT NULL REFERENCES squadrons(squadron_id)
);
CREATE TABLE terms (
  term_id TEXT PRIMARY KEY, label TEXT NOT NULL, sort_order INTEGER NOT NULL UNIQUE,
  is_current INTEGER NOT NULL CHECK (is_current IN (0,1))
);
CREATE UNIQUE INDEX terms_one_current ON terms(is_current) WHERE is_current=1;
CREATE TABLE directory_profiles (
  person_id TEXT PRIMARY KEY REFERENCES people(person_id), version INTEGER NOT NULL CHECK (version>0),
  flight_id TEXT REFERENCES organizational_units(unit_id),
  last_name TEXT NOT NULL, first_name TEXT NOT NULL, as_year TEXT NOT NULL, rank TEXT NOT NULL,
  role TEXT NOT NULL, university TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL, dorm TEXT NOT NULL,
  cip_broad_area TEXT NOT NULL, cip_code TEXT NOT NULL, afsc TEXT NOT NULL, home_town TEXT NOT NULL,
  home_state TEXT NOT NULL, class_year TEXT NOT NULL, date_of_birth TEXT,
  flight_path_status TEXT NOT NULL, photo_link TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX directory_email_unique ON directory_profiles(email) WHERE email<>'';
CREATE TABLE leadership_contacts (
  contact_id TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK (version>0),
  person_id TEXT UNIQUE REFERENCES people(person_id), last_name TEXT NOT NULL, first_name TEXT NOT NULL,
  rank TEXT NOT NULL, role TEXT NOT NULL, email TEXT NOT NULL, cell_phone TEXT NOT NULL,
  reports_to TEXT NOT NULL, office_phone TEXT NOT NULL, office_location TEXT NOT NULL,
  active INTEGER NOT NULL CHECK (active IN (0,1)), updated_at TEXT NOT NULL
);
CREATE TABLE event_details (
  event_id TEXT PRIMARY KEY REFERENCES events(event_id), version INTEGER NOT NULL CHECK (version>0),
  term_id TEXT NOT NULL REFERENCES terms(term_id), event_type TEXT NOT NULL CHECK (event_type IN ('mando','secondary','llab','other')),
  training_week INTEGER, display_order INTEGER NOT NULL, column_label TEXT NOT NULL, expected_group TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','cancelled','inactive','archived')),
  start_at TEXT, end_at TEXT, location TEXT NOT NULL, notes TEXT NOT NULL,
  created_at TEXT NOT NULL, created_by TEXT NOT NULL REFERENCES principals(principal_id), updated_at TEXT NOT NULL
);
CREATE INDEX event_details_term_order ON event_details(term_id,display_order,event_id);
CREATE TABLE admin_grants (
  principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  capability TEXT NOT NULL CHECK (capability IN ('directory.manage','leadership.manage','events.manage','frontend.read','attendance.correct','notifications.manage')),
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('wing','flight')), scope_key TEXT NOT NULL,
  CHECK ((scope_kind='wing' AND scope_key='*') OR (scope_kind='flight' AND scope_key<>'*')),
  PRIMARY KEY (principal_id,capability,scope_kind,scope_key)
);
-- Shared command identity lets all operation families reference one refresh queue.
CREATE TABLE command_registry (
  command_id TEXT PRIMARY KEY, ledger TEXT NOT NULL CHECK (ledger IN ('admin','operation'))
);
INSERT INTO command_registry(command_id,ledger) SELECT command_id,'operation' FROM operation_commands;
CREATE TABLE admin_commands (
  command_id TEXT PRIMARY KEY REFERENCES command_registry(command_id), payload_hash TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES principals(principal_id),
  operation TEXT NOT NULL, target_id TEXT NOT NULL, capability TEXT NOT NULL,
  scopes_json TEXT NOT NULL, source_kind TEXT NOT NULL, source_resource TEXT NOT NULL,
  source_submission TEXT NOT NULL, source_revision INTEGER NOT NULL, accepted_at TEXT NOT NULL, receipt_json TEXT NOT NULL,
  UNIQUE (source_kind,source_resource,source_submission,source_revision,operation)
);
CREATE TABLE admin_audit_events (
  audit_id INTEGER PRIMARY KEY AUTOINCREMENT, command_id TEXT NOT NULL UNIQUE REFERENCES admin_commands(command_id),
  actor_id TEXT NOT NULL REFERENCES principals(principal_id), actor_evidence TEXT NOT NULL,
  operation TEXT NOT NULL, target_id TEXT NOT NULL, accepted_at TEXT NOT NULL,
  before_json TEXT NOT NULL, after_json TEXT NOT NULL
);
CREATE TABLE directory_membership_history (
  history_id INTEGER PRIMARY KEY AUTOINCREMENT, command_id TEXT NOT NULL UNIQUE REFERENCES admin_commands(command_id),
  person_id TEXT NOT NULL REFERENCES people(person_id), previous_flight_id TEXT REFERENCES organizational_units(unit_id),
  flight_id TEXT REFERENCES organizational_units(unit_id), active INTEGER NOT NULL CHECK (active IN (0,1)), accepted_at TEXT NOT NULL
);
CREATE TABLE admin_effects (
  effect_id TEXT PRIMARY KEY, command_id TEXT NOT NULL REFERENCES command_registry(command_id),
  kind TEXT NOT NULL CHECK (kind IN ('frontend.refresh','forms.refresh')), state TEXT NOT NULL CHECK (state IN ('pending','leased','done')),
  created_at TEXT NOT NULL, worker_id TEXT, claim_token TEXT, lease_expires_at TEXT, completed_at TEXT,
  claim_operations_revision INTEGER CHECK(claim_operations_revision>=0),
  claim_administration_revision INTEGER CHECK(claim_administration_revision>=0),
  completed_by_effect_id TEXT REFERENCES admin_effects(effect_id),
  CHECK((claim_operations_revision IS NULL AND claim_administration_revision IS NULL)
    OR (claim_operations_revision IS NOT NULL AND claim_administration_revision IS NOT NULL))
);
CREATE INDEX admin_effects_pending ON admin_effects(state,created_at,effect_id);
CREATE INDEX admin_effects_kind_lease ON admin_effects(kind,state);
