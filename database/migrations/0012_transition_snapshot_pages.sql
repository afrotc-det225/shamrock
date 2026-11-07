-- Immutable, resumable capture before a reviewed transition is committed.
CREATE TABLE transition_snapshot_preparations (
  command_id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES principals(principal_id),
  environment TEXT NOT NULL CHECK(environment IN ('local','staging')), generation INTEGER NOT NULL CHECK(generation>0),
  source_kind TEXT NOT NULL, source_resource TEXT NOT NULL, plan_json TEXT NOT NULL CHECK(json_valid(plan_json)), event_week INTEGER NOT NULL CHECK(event_week>=0 AND event_week<=20),
  state TEXT NOT NULL CHECK(state IN ('capturing','complete','consumed','abandoned')),
  manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
  next_section INTEGER NOT NULL CHECK(next_section>=0), next_offset INTEGER NOT NULL CHECK(next_offset>=0),
  page_count INTEGER NOT NULL CHECK(page_count>=0 AND page_count<=512), total_bytes INTEGER NOT NULL CHECK(total_bytes>=0 AND total_bytes<=5242880),
  descriptor_json TEXT CHECK(descriptor_json IS NULL OR json_valid(descriptor_json)), descriptor_hash TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX transition_snapshot_actor_state ON transition_snapshot_preparations(actor_id,state,created_at);
CREATE TABLE transition_snapshot_pages (
  command_id TEXT NOT NULL REFERENCES transition_snapshot_preparations(command_id),
  sequence INTEGER NOT NULL CHECK(sequence>=0 AND sequence<512), section TEXT NOT NULL, page_offset INTEGER NOT NULL,
  page_hash TEXT NOT NULL, page_bytes INTEGER NOT NULL CHECK(page_bytes>0 AND page_bytes<=128000),
  page_json TEXT NOT NULL CHECK(json_valid(page_json)),
  PRIMARY KEY(command_id,sequence), UNIQUE(command_id,section,page_offset)
);
CREATE TABLE transition_snapshot_bindings (
  transition_id TEXT PRIMARY KEY REFERENCES term_transitions(transition_id),
  preparation_command_id TEXT NOT NULL UNIQUE REFERENCES transition_snapshot_preparations(command_id),
  descriptor_hash TEXT NOT NULL, assembled_snapshot_hash TEXT,
  CHECK(assembled_snapshot_hash IS NULL OR length(assembled_snapshot_hash)=64)
);
CREATE TABLE transition_prepared_event_pages (
  command_id TEXT NOT NULL REFERENCES transition_snapshot_preparations(command_id), week_index INTEGER NOT NULL CHECK(week_index>=0 AND week_index<20),
  events_json TEXT NOT NULL CHECK(json_valid(events_json)), events_hash TEXT NOT NULL,
  PRIMARY KEY(command_id,week_index)
);
