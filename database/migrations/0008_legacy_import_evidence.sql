-- Initial, paused staging import only. Baselines are effective state, never fabricated observations.
CREATE TABLE legacy_import_runs (
  import_run_id TEXT PRIMARY KEY, snapshot_sha256 TEXT NOT NULL UNIQUE,
  plan_sha256 TEXT NOT NULL, reconciliation_sha256 TEXT NOT NULL,
  review_reference TEXT NOT NULL, environment TEXT NOT NULL CHECK(environment='staging'),
  generation INTEGER NOT NULL CHECK(generation>0),
  state TEXT NOT NULL CHECK(state IN ('loading','complete')),
  expected_occurrences INTEGER NOT NULL CHECK(expected_occurrences>0),
  expected_profiles INTEGER NOT NULL CHECK(expected_profiles>0),
  expected_events INTEGER NOT NULL CHECK(expected_events>0),
  expected_baselines INTEGER NOT NULL CHECK(expected_baselines>0),
  expected_batches INTEGER NOT NULL CHECK(expected_batches>0),
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
  started_at TEXT NOT NULL, completed_at TEXT
);
CREATE TABLE legacy_import_assertions (
  assertion_id TEXT PRIMARY KEY, ok INTEGER NOT NULL CHECK(ok=1)
);
CREATE TABLE legacy_import_batches (
  import_run_id TEXT NOT NULL REFERENCES legacy_import_runs(import_run_id),
  batch_index INTEGER NOT NULL CHECK(batch_index>=0), payload_sha256 TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  PRIMARY KEY(import_run_id,batch_index)
);
CREATE TABLE legacy_source_occurrences (
  import_run_id TEXT NOT NULL REFERENCES legacy_import_runs(import_run_id), occurrence_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL, source_kind TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK(disposition IN ('normalized','evidence-only','quarantined')),
  locator_json TEXT NOT NULL CHECK(json_valid(locator_json)),
  raw_json TEXT NOT NULL CHECK(json_valid(raw_json)),
  normalized_json TEXT CHECK(normalized_json IS NULL OR json_valid(normalized_json)),
  diagnostics_json TEXT NOT NULL CHECK(json_valid(diagnostics_json)),
  PRIMARY KEY(import_run_id,occurrence_id)
);
CREATE TABLE legacy_profile_sources (
  person_id TEXT PRIMARY KEY REFERENCES people(person_id), import_run_id TEXT NOT NULL,
  source_occurrence_id TEXT NOT NULL,
  FOREIGN KEY(import_run_id,source_occurrence_id) REFERENCES legacy_source_occurrences(import_run_id,occurrence_id)
);
CREATE TABLE legacy_event_sources (
  event_id TEXT PRIMARY KEY REFERENCES events(event_id), import_run_id TEXT NOT NULL,
  source_occurrence_id TEXT NOT NULL, eligibility_evidence_json TEXT NOT NULL CHECK(json_valid(eligibility_evidence_json)),
  FOREIGN KEY(import_run_id,source_occurrence_id) REFERENCES legacy_source_occurrences(import_run_id,occurrence_id)
);
CREATE TABLE legacy_attendance_baselines (
  baseline_id TEXT PRIMARY KEY, person_id TEXT NOT NULL REFERENCES people(person_id),
  event_id TEXT NOT NULL REFERENCES events(event_id),
  code TEXT CHECK(code IS NULL OR code IN ('P','T','A','U','E','ES','MED','R','D','N/A')),
  import_run_id TEXT NOT NULL, source_occurrence_id TEXT NOT NULL,
  source_column_index INTEGER NOT NULL CHECK(source_column_index>=0),
  UNIQUE(person_id,event_id),
  FOREIGN KEY(import_run_id,source_occurrence_id) REFERENCES legacy_source_occurrences(import_run_id,occurrence_id)
);
CREATE INDEX legacy_baselines_pair ON legacy_attendance_baselines(event_id,person_id);
CREATE TABLE legacy_matrix_snapshots (
  matrix_snapshot_id TEXT PRIMARY KEY, import_run_id TEXT NOT NULL REFERENCES legacy_import_runs(import_run_id),
  source_resource_key TEXT NOT NULL, source_sheet_id INTEGER NOT NULL,
  metadata_json TEXT NOT NULL CHECK(json_valid(metadata_json)),
  roster_json TEXT NOT NULL CHECK(json_valid(roster_json))
);
CREATE TABLE legacy_matrix_snapshot_rows (
  matrix_snapshot_id TEXT NOT NULL REFERENCES legacy_matrix_snapshots(matrix_snapshot_id),
  source_occurrence_id TEXT NOT NULL, person_id TEXT,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  PRIMARY KEY(matrix_snapshot_id,source_occurrence_id)
);
CREATE TABLE legacy_native_response_provenance (
  import_run_id TEXT NOT NULL, source_occurrence_id TEXT NOT NULL,
  form_resource_key TEXT NOT NULL, response_id TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  PRIMARY KEY(import_run_id,source_occurrence_id),
  FOREIGN KEY(import_run_id,source_occurrence_id) REFERENCES legacy_source_occurrences(import_run_id,occurrence_id)
);
