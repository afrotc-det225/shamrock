-- Explicit roots are provisioned privately; no account or role is trusted by this migration.
CREATE TABLE permission_managers (
  principal_id TEXT PRIMARY KEY REFERENCES principals(principal_id),
  active INTEGER NOT NULL CHECK(active IN (0,1))
);
CREATE TABLE principal_accounts (
  principal_id TEXT PRIMARY KEY REFERENCES principals(principal_id),
  email TEXT NOT NULL UNIQUE CHECK(email=lower(email)),
  evidence TEXT NOT NULL CHECK(evidence IN ('google-form','authenticated-confirmation')),
  bound_command_id TEXT NOT NULL REFERENCES command_registry(command_id)
);
CREATE TABLE permission_policy_control (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  version INTEGER NOT NULL CHECK(version>=0), policy_json TEXT NOT NULL, policy_hash TEXT NOT NULL,
  last_command_id TEXT REFERENCES command_registry(command_id), config_json TEXT NOT NULL DEFAULT '{}'
);
INSERT INTO permission_policy_control(singleton,enabled,version,policy_json,policy_hash)
  SELECT 1,0,0,'{}','';
CREATE TABLE role_permission_members (
  principal_id TEXT PRIMARY KEY REFERENCES principals(principal_id),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('directory','leadership')),
  source_id TEXT NOT NULL, source_version INTEGER NOT NULL CHECK(source_version>0),
  linked_contact_id TEXT, linked_contact_version INTEGER,
  policy_version INTEGER NOT NULL CHECK(policy_version>0),
  source_role TEXT NOT NULL, source_flight_id TEXT, source_status TEXT, linked_contact_active INTEGER
);
CREATE TABLE role_access_grants (
  principal_id TEXT NOT NULL REFERENCES role_permission_members(principal_id) ON DELETE CASCADE,
  capability TEXT NOT NULL CHECK(capability IN ('attendance.report','excusal.submit','excusal.decide')),
  unit_id TEXT NOT NULL REFERENCES organizational_units(unit_id),
  subject_scope TEXT NOT NULL CHECK(subject_scope IN ('self','unit')),
  PRIMARY KEY(principal_id,capability,unit_id)
);
CREATE TABLE role_admin_grants (
  principal_id TEXT NOT NULL REFERENCES role_permission_members(principal_id) ON DELETE CASCADE,
  capability TEXT NOT NULL CHECK(capability IN ('leadership.manage','frontend.read','attendance.correct')),
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('wing','flight')), scope_key TEXT NOT NULL,
  PRIMARY KEY(principal_id,capability,scope_kind,scope_key)
);
CREATE TABLE permission_policy_audit (
  version INTEGER PRIMARY KEY, command_id TEXT NOT NULL UNIQUE REFERENCES command_registry(command_id),
  actor_id TEXT NOT NULL REFERENCES principals(principal_id), accepted_at TEXT NOT NULL,
  before_hash TEXT NOT NULL, after_hash TEXT NOT NULL, policy_json TEXT NOT NULL
);
CREATE TABLE permission_refresh_jobs (
  job_id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE REFERENCES command_registry(command_id),
  version INTEGER NOT NULL UNIQUE REFERENCES permission_policy_audit(version),
  state TEXT NOT NULL CHECK(state IN ('pending','leased','done')),
  worker_id TEXT, claim_token TEXT, lease_expires_at TEXT, frozen_policy_json TEXT,
  completed_at TEXT, completed_by_job_id TEXT REFERENCES permission_refresh_jobs(job_id)
);
CREATE INDEX permission_refresh_pending ON permission_refresh_jobs(state,version);

CREATE TABLE permission_commands (
  command_id TEXT PRIMARY KEY REFERENCES command_registry(command_id),
  actor_id TEXT NOT NULL REFERENCES principals(principal_id), payload_hash TEXT NOT NULL,
  receipt_json TEXT NOT NULL, accepted_at TEXT NOT NULL
);
CREATE TABLE permission_command_requirements (
  command_id TEXT PRIMARY KEY REFERENCES command_registry(command_id)
);
CREATE TABLE permission_publishers (
  principal_id TEXT PRIMARY KEY REFERENCES principals(principal_id),
  active INTEGER NOT NULL CHECK(active IN (0,1))
);
CREATE TABLE permission_change_fences (
  command_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, policy_version INTEGER NOT NULL,
  publisher_id TEXT NOT NULL REFERENCES permission_publishers(principal_id),
  checkpoint_sha256 TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE TABLE permission_refresh_recoveries (
  recovery_id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES permission_refresh_jobs(job_id),
  publisher_id TEXT NOT NULL REFERENCES permission_publishers(principal_id),
  worker_id TEXT NOT NULL, claim_token TEXT NOT NULL, previous_expiry TEXT NOT NULL,
  new_expiry TEXT NOT NULL, checkpoint_sha256 TEXT NOT NULL, accepted_at TEXT NOT NULL
);
