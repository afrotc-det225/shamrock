-- Portal review notes and Flight duties never confer SHAMROCK permissions.
CREATE TABLE cadet_workspace_actions (
  action_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('flag','resolve','duty')),
  actor_person_id TEXT NOT NULL REFERENCES people(person_id),
  subject_person_id TEXT NOT NULL REFERENCES people(person_id),
  flight_id TEXT NOT NULL REFERENCES organizational_units(unit_id),
  event_id TEXT REFERENCES events(event_id),
  parent_id TEXT REFERENCES cadet_workspace_actions(action_id),
  detail TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  UNIQUE(parent_id),
  CHECK((kind='flag' AND event_id IS NOT NULL AND parent_id IS NULL AND actor_person_id=subject_person_id)
     OR (kind='resolve' AND event_id IS NOT NULL AND parent_id IS NOT NULL)
     OR (kind='duty' AND event_id IS NULL AND parent_id IS NULL))
);
CREATE INDEX cadet_workspace_by_flight ON cadet_workspace_actions(flight_id,kind,accepted_at);
CREATE INDEX cadet_workspace_by_person ON cadet_workspace_actions(subject_person_id,kind,accepted_at);
