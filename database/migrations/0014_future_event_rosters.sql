-- Future event rosters follow an explicitly approved, versioned current-membership policy.
-- Historical roster versions and attendance/excusal evidence are never updated or deleted.
CREATE TABLE event_roster_policies (
  event_id TEXT PRIMARY KEY REFERENCES event_details(event_id),
  version INTEGER NOT NULL CHECK(version>0),
  policy TEXT NOT NULL CHECK(policy='current-active-flight-v1'),
  enabled INTEGER NOT NULL CHECK(enabled IN(0,1)),
  selected_flight_ids_json TEXT NOT NULL CHECK(json_valid(selected_flight_ids_json) AND json_type(selected_flight_ids_json)='array'),
  approved_command_id TEXT NOT NULL REFERENCES admin_commands(command_id),
  approved_actor_id TEXT NOT NULL REFERENCES principals(principal_id),
  approved_at TEXT NOT NULL,last_refreshed_at TEXT
);
CREATE TABLE event_roster_refresh_work (
  event_id TEXT PRIMARY KEY REFERENCES event_roster_policies(event_id),
  cause_command_id TEXT NOT NULL REFERENCES admin_commands(command_id),requested_at TEXT NOT NULL
);
CREATE INDEX event_roster_refresh_requested ON event_roster_refresh_work(requested_at,event_id);
