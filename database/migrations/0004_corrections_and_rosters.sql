-- Corrections append evidence to the same causal audit stream as attendance and excusals.
CREATE TABLE attendance_corrections (
  correction_id TEXT PRIMARY KEY, command_id TEXT NOT NULL UNIQUE REFERENCES operation_commands(command_id),
  event_id TEXT NOT NULL REFERENCES events(event_id), person_id TEXT NOT NULL REFERENCES people(person_id),
  code TEXT CHECK (code IN ('P','T','A','U','E','ES','MED','R','D','N/A') OR code IS NULL),
  reason TEXT NOT NULL, base_version INTEGER NOT NULL CHECK (base_version>=0),
  event_version INTEGER NOT NULL CHECK (event_version>0), accepted_at TEXT NOT NULL
);
CREATE INDEX corrections_pair ON attendance_corrections(event_id,person_id,command_id);
-- An event roster is explicit and immutable for each accepted event version.
CREATE TABLE event_roster_versions (
  event_id TEXT NOT NULL REFERENCES events(event_id), version INTEGER NOT NULL CHECK (version>0),
  command_id TEXT NOT NULL UNIQUE REFERENCES admin_commands(command_id), accepted_at TEXT NOT NULL,
  PRIMARY KEY (event_id,version)
);
CREATE TABLE event_roster_members (
  event_id TEXT NOT NULL, version INTEGER NOT NULL, person_id TEXT NOT NULL REFERENCES people(person_id),
  flight_id TEXT NOT NULL REFERENCES organizational_units(unit_id),
  last_name TEXT NOT NULL, first_name TEXT NOT NULL, as_year TEXT NOT NULL, flight_path_status TEXT NOT NULL, date_of_birth TEXT,
  PRIMARY KEY (event_id,version,person_id),
  FOREIGN KEY (event_id,version) REFERENCES event_roster_versions(event_id,version)
);
CREATE INDEX event_roster_person ON event_roster_members(person_id,event_id,version);
-- Current-term profile snapshots stop changing when the catalog advances to a new term.
CREATE TABLE term_roster_snapshots (
  term_id TEXT NOT NULL REFERENCES terms(term_id), person_id TEXT NOT NULL REFERENCES people(person_id),
  last_name TEXT NOT NULL, first_name TEXT NOT NULL, as_year TEXT NOT NULL,
  flight_id TEXT REFERENCES organizational_units(unit_id), flight_path_status TEXT NOT NULL, date_of_birth TEXT,
  command_id TEXT NOT NULL REFERENCES admin_commands(command_id),
  PRIMARY KEY (term_id,person_id)
);
