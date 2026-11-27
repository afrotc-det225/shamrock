-- Point lookups retain case-insensitive identity matching and detect ambiguous accounts.
CREATE INDEX cadet_directory_email ON directory_profiles(lower(email),person_id);
CREATE INDEX cadet_principal_person ON principals(person_id,principal_id);
CREATE INDEX cadet_squadron_roles ON directory_profiles(person_id) WHERE instr(lower(role),'squadron')>0;
CREATE INDEX cadet_person_requests ON excusal_records(person_id,event_id) WHERE origin='native' OR last_command_id IS NOT NULL;
CREATE INDEX cadet_person_observations ON attendance_observations(person_id,event_id);
CREATE INDEX cadet_person_corrections ON attendance_corrections(person_id,event_id);

-- Transactional source indexes for personal attendance. Buckets hold only fields
-- used by the reader. A changed source row updates its individual JSON entry.
CREATE TABLE cadet_attendance_index (
  kind TEXT NOT NULL, bucket TEXT NOT NULL, entries TEXT NOT NULL,
  PRIMARY KEY(kind,bucket)
) WITHOUT ROWID;

INSERT INTO cadet_attendance_index SELECT 'directory_profiles','*',json_group_object(hex(json_array(person_id)),json_array(person_id,last_name,first_name,as_year,role)) FROM directory_profiles GROUP BY 1,2;
CREATE TRIGGER cadet_index_directory_profiles_insert AFTER INSERT ON directory_profiles BEGIN
  INSERT INTO cadet_attendance_index VALUES('directory_profiles','*',json_object(hex(json_array(NEW.person_id)),json_array(NEW.person_id,NEW.last_name,NEW.first_name,NEW.as_year,NEW.role)))
    ON CONFLICT(kind,bucket) DO UPDATE SET entries=json_set(entries,'$."' || hex(json_array(NEW.person_id)) || '"',json_array(NEW.person_id,NEW.last_name,NEW.first_name,NEW.as_year,NEW.role));
END;
CREATE TRIGGER cadet_index_directory_profiles_update AFTER UPDATE OF person_id,last_name,first_name,as_year,role ON directory_profiles BEGIN
  UPDATE cadet_attendance_index SET entries=json_remove(entries,'$."' || hex(json_array(OLD.person_id)) || '"') WHERE kind='directory_profiles' AND bucket='*';
  INSERT INTO cadet_attendance_index VALUES('directory_profiles','*',json_object(hex(json_array(NEW.person_id)),json_array(NEW.person_id,NEW.last_name,NEW.first_name,NEW.as_year,NEW.role)))
    ON CONFLICT(kind,bucket) DO UPDATE SET entries=json_set(entries,'$."' || hex(json_array(NEW.person_id)) || '"',json_array(NEW.person_id,NEW.last_name,NEW.first_name,NEW.as_year,NEW.role));
END;
CREATE TRIGGER cadet_index_directory_profiles_delete AFTER DELETE ON directory_profiles BEGIN
  UPDATE cadet_attendance_index SET entries=json_remove(entries,'$."' || hex(json_array(OLD.person_id)) || '"') WHERE kind='directory_profiles' AND bucket='*';
END;

INSERT INTO cadet_attendance_index SELECT 'events','*',json_group_object(hex(json_array(event_id)),json_array(event_id,label)) FROM events GROUP BY 1,2;
CREATE TRIGGER cadet_index_events_insert AFTER INSERT ON events BEGIN
  INSERT INTO cadet_attendance_index VALUES('events','*',json_object(hex(json_array(NEW.event_id)),json_array(NEW.event_id,NEW.label)))
    ON CONFLICT(kind,bucket) DO UPDATE SET entries=json_set(entries,'$."' || hex(json_array(NEW.event_id)) || '"',json_array(NEW.event_id,NEW.label));
END;
CREATE TRIGGER cadet_index_events_update AFTER UPDATE OF event_id,label ON events BEGIN
  UPDATE cadet_attendance_index SET entries=json_remove(entries,'$."' || hex(json_array(OLD.event_id)) || '"') WHERE kind='events' AND bucket='*';
  INSERT INTO cadet_attendance_index VALUES('events','*',json_object(hex(json_array(NEW.event_id)),json_array(NEW.event_id,NEW.label)))
    ON CONFLICT(kind,bucket) DO UPDATE SET entries=json_set(entries,'$."' || hex(json_array(NEW.event_id)) || '"',json_array(NEW.event_id,NEW.label));
END;
CREATE TRIGGER cadet_index_events_delete AFTER DELETE ON events BEGIN
  UPDATE cadet_attendance_index SET entries=json_remove(entries,'$."' || hex(json_array(OLD.event_id)) || '"') WHERE kind='events' AND bucket='*';
END;

INSERT INTO cadet_attendance_index SELECT 'event_details',term_id,json_group_object(hex(json_array(event_id)),json_array(event_id,term_id,event_type,column_label,training_week,version,display_order,status)) FROM event_details GROUP BY 1,2;
CREATE TRIGGER cadet_index_event_details_insert AFTER INSERT ON event_details BEGIN
  INSERT INTO cadet_attendance_index VALUES('event_details',NEW.term_id,json_object(hex(json_array(NEW.event_id)),json_array(NEW.event_id,NEW.term_id,NEW.event_type,NEW.column_label,NEW.training_week,NEW.version,NEW.display_order,NEW.status)))
    ON CONFLICT(kind,bucket) DO UPDATE SET entries=json_set(entries,'$."' || hex(json_array(NEW.event_id)) || '"',json_array(NEW.event_id,NEW.term_id,NEW.event_type,NEW.column_label,NEW.training_week,NEW.version,NEW.display_order,NEW.status));
END;
CREATE TRIGGER cadet_index_event_details_update AFTER UPDATE OF term_id,event_id,event_type,column_label,training_week,version,display_order,status ON event_details BEGIN
  UPDATE cadet_attendance_index SET entries=json_remove(entries,'$."' || hex(json_array(OLD.event_id)) || '"') WHERE kind='event_details' AND bucket=OLD.term_id;
  INSERT INTO cadet_attendance_index VALUES('event_details',NEW.term_id,json_object(hex(json_array(NEW.event_id)),json_array(NEW.event_id,NEW.term_id,NEW.event_type,NEW.column_label,NEW.training_week,NEW.version,NEW.display_order,NEW.status)))
    ON CONFLICT(kind,bucket) DO UPDATE SET entries=json_set(entries,'$."' || hex(json_array(NEW.event_id)) || '"',json_array(NEW.event_id,NEW.term_id,NEW.event_type,NEW.column_label,NEW.training_week,NEW.version,NEW.display_order,NEW.status));
END;
CREATE TRIGGER cadet_index_event_details_delete AFTER DELETE ON event_details BEGIN
  UPDATE cadet_attendance_index SET entries=json_remove(entries,'$."' || hex(json_array(OLD.event_id)) || '"') WHERE kind='event_details' AND bucket=OLD.term_id;
END;

INSERT INTO cadet_attendance_index SELECT 'event_units',unit_id,json_group_object(hex(json_array(event_id)),json_array(event_id)) FROM event_units GROUP BY 1,2;
CREATE TRIGGER cadet_index_event_units_insert AFTER INSERT ON event_units BEGIN
  INSERT INTO cadet_attendance_index VALUES('event_units',NEW.unit_id,json_object(hex(json_array(NEW.event_id)),json_array(NEW.event_id)))
    ON CONFLICT(kind,bucket) DO UPDATE SET entries=json_set(entries,'$."' || hex(json_array(NEW.event_id)) || '"',json_array(NEW.event_id));
END;
CREATE TRIGGER cadet_index_event_units_update AFTER UPDATE OF unit_id,event_id ON event_units BEGIN
  UPDATE cadet_attendance_index SET entries=json_remove(entries,'$."' || hex(json_array(OLD.event_id)) || '"') WHERE kind='event_units' AND bucket=OLD.unit_id;
  INSERT INTO cadet_attendance_index VALUES('event_units',NEW.unit_id,json_object(hex(json_array(NEW.event_id)),json_array(NEW.event_id)))
    ON CONFLICT(kind,bucket) DO UPDATE SET entries=json_set(entries,'$."' || hex(json_array(NEW.event_id)) || '"',json_array(NEW.event_id));
END;
CREATE TRIGGER cadet_index_event_units_delete AFTER DELETE ON event_units BEGIN
  UPDATE cadet_attendance_index SET entries=json_remove(entries,'$."' || hex(json_array(OLD.event_id)) || '"') WHERE kind='event_units' AND bucket=OLD.unit_id;
END;

INSERT INTO cadet_attendance_index SELECT 'event_roster_versions','*',json_group_object(hex(json_array(event_id,version)),json_array(event_id,version)) FROM event_roster_versions GROUP BY 1,2;
CREATE TRIGGER cadet_index_event_roster_versions_insert AFTER INSERT ON event_roster_versions BEGIN
  INSERT INTO cadet_attendance_index VALUES('event_roster_versions','*',json_object(hex(json_array(NEW.event_id,NEW.version)),json_array(NEW.event_id,NEW.version)))
    ON CONFLICT(kind,bucket) DO UPDATE SET entries=json_set(entries,'$."' || hex(json_array(NEW.event_id,NEW.version)) || '"',json_array(NEW.event_id,NEW.version));
END;
CREATE TRIGGER cadet_index_event_roster_versions_update AFTER UPDATE OF event_id,version ON event_roster_versions BEGIN
  UPDATE cadet_attendance_index SET entries=json_remove(entries,'$."' || hex(json_array(OLD.event_id,OLD.version)) || '"') WHERE kind='event_roster_versions' AND bucket='*';
  INSERT INTO cadet_attendance_index VALUES('event_roster_versions','*',json_object(hex(json_array(NEW.event_id,NEW.version)),json_array(NEW.event_id,NEW.version)))
    ON CONFLICT(kind,bucket) DO UPDATE SET entries=json_set(entries,'$."' || hex(json_array(NEW.event_id,NEW.version)) || '"',json_array(NEW.event_id,NEW.version));
END;
CREATE TRIGGER cadet_index_event_roster_versions_delete AFTER DELETE ON event_roster_versions BEGIN
  UPDATE cadet_attendance_index SET entries=json_remove(entries,'$."' || hex(json_array(OLD.event_id,OLD.version)) || '"') WHERE kind='event_roster_versions' AND bucket='*';
END;

INSERT INTO cadet_attendance_index SELECT 'event_roster_members',person_id,json_group_object(hex(json_array(event_id,version)),json_array(event_id,version)) FROM event_roster_members GROUP BY 1,2;
CREATE TRIGGER cadet_index_event_roster_members_insert AFTER INSERT ON event_roster_members BEGIN
  INSERT INTO cadet_attendance_index VALUES('event_roster_members',NEW.person_id,json_object(hex(json_array(NEW.event_id,NEW.version)),json_array(NEW.event_id,NEW.version)))
    ON CONFLICT(kind,bucket) DO UPDATE SET entries=json_set(entries,'$."' || hex(json_array(NEW.event_id,NEW.version)) || '"',json_array(NEW.event_id,NEW.version));
END;
CREATE TRIGGER cadet_index_event_roster_members_update AFTER UPDATE OF person_id,event_id,version ON event_roster_members BEGIN
  UPDATE cadet_attendance_index SET entries=json_remove(entries,'$."' || hex(json_array(OLD.event_id,OLD.version)) || '"') WHERE kind='event_roster_members' AND bucket=OLD.person_id;
  INSERT INTO cadet_attendance_index VALUES('event_roster_members',NEW.person_id,json_object(hex(json_array(NEW.event_id,NEW.version)),json_array(NEW.event_id,NEW.version)))
    ON CONFLICT(kind,bucket) DO UPDATE SET entries=json_set(entries,'$."' || hex(json_array(NEW.event_id,NEW.version)) || '"',json_array(NEW.event_id,NEW.version));
END;
CREATE TRIGGER cadet_index_event_roster_members_delete AFTER DELETE ON event_roster_members BEGIN
  UPDATE cadet_attendance_index SET entries=json_remove(entries,'$."' || hex(json_array(OLD.event_id,OLD.version)) || '"') WHERE kind='event_roster_members' AND bucket=OLD.person_id;
END;

INSERT INTO cadet_attendance_index SELECT 'legacy_attendance_baselines',person_id,json_group_object(hex(json_array(event_id)),json_array(event_id,code,import_run_id,baseline_id)) FROM legacy_attendance_baselines GROUP BY 1,2;
CREATE TRIGGER cadet_index_legacy_attendance_baselines_insert AFTER INSERT ON legacy_attendance_baselines BEGIN
  INSERT INTO cadet_attendance_index VALUES('legacy_attendance_baselines',NEW.person_id,json_object(hex(json_array(NEW.event_id)),json_array(NEW.event_id,NEW.code,NEW.import_run_id,NEW.baseline_id)))
    ON CONFLICT(kind,bucket) DO UPDATE SET entries=json_set(entries,'$."' || hex(json_array(NEW.event_id)) || '"',json_array(NEW.event_id,NEW.code,NEW.import_run_id,NEW.baseline_id));
END;
CREATE TRIGGER cadet_index_legacy_attendance_baselines_update AFTER UPDATE OF person_id,event_id,code,import_run_id,baseline_id ON legacy_attendance_baselines BEGIN
  UPDATE cadet_attendance_index SET entries=json_remove(entries,'$."' || hex(json_array(OLD.event_id)) || '"') WHERE kind='legacy_attendance_baselines' AND bucket=OLD.person_id;
  INSERT INTO cadet_attendance_index VALUES('legacy_attendance_baselines',NEW.person_id,json_object(hex(json_array(NEW.event_id)),json_array(NEW.event_id,NEW.code,NEW.import_run_id,NEW.baseline_id)))
    ON CONFLICT(kind,bucket) DO UPDATE SET entries=json_set(entries,'$."' || hex(json_array(NEW.event_id)) || '"',json_array(NEW.event_id,NEW.code,NEW.import_run_id,NEW.baseline_id));
END;
CREATE TRIGGER cadet_index_legacy_attendance_baselines_delete AFTER DELETE ON legacy_attendance_baselines BEGIN
  UPDATE cadet_attendance_index SET entries=json_remove(entries,'$."' || hex(json_array(OLD.event_id)) || '"') WHERE kind='legacy_attendance_baselines' AND bucket=OLD.person_id;
END;
