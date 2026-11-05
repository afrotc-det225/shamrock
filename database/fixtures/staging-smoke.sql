-- Fictional fixture for a fresh, fenced staging database only.
-- Submit every statement together in one atomic D1 API batch.
INSERT INTO command_assertions(command_id,ok)
SELECT 'staging-fixture-setup', CASE WHEN
  EXISTS(SELECT 1 FROM system_control WHERE singleton=1 AND environment='staging' AND accepting_commands=0)
  AND NOT EXISTS(SELECT 1 FROM people)
  AND NOT EXISTS(SELECT 1 FROM principals)
  AND NOT EXISTS(SELECT 1 FROM organizational_units)
  AND NOT EXISTS(SELECT 1 FROM events)
  AND NOT EXISTS(SELECT 1 FROM adapter_sources)
  AND NOT EXISTS(SELECT 1 FROM operation_commands)
THEN 1 ELSE 0 END;

INSERT INTO people(person_id,display_name) VALUES
  ('staging-person-a','Fictional Cadet A'),('staging-person-b','Fictional Cadet B');
INSERT INTO principals(principal_id,person_id,active) VALUES
  ('staging-representative',NULL,1),('staging-cadet-a','staging-person-a',1),('staging-approver',NULL,1);
INSERT INTO organizational_units(unit_id,label,roster_version) VALUES('staging-alpha','Fictional Alpha',1);
INSERT INTO memberships(person_id,unit_id,active) VALUES
  ('staging-person-a','staging-alpha',1),('staging-person-b','staging-alpha',1);
INSERT INTO events(event_id,label,active) VALUES('staging-event','Fictional staging event',1);
INSERT INTO event_units(event_id,unit_id) VALUES('staging-event','staging-alpha');
INSERT INTO access_grants(principal_id,capability,unit_id,subject_scope) VALUES
  ('staging-representative','attendance.report','staging-alpha','unit'),
  ('staging-cadet-a','excusal.submit','staging-alpha','self'),
  ('staging-approver','excusal.decide','staging-alpha','unit');
INSERT INTO adapter_sources(source_kind,resource_key,active) VALUES('test','staging-smoke',1);
DELETE FROM command_assertions WHERE command_id='staging-fixture-setup';
