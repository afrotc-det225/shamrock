-- Versioned current catalog with retained retirement tombstones; stable IDs never retarget history.
CREATE TABLE organizational_catalog_versions (
  kind TEXT NOT NULL CHECK(kind IN ('flight','squadron')), target_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version>0), value_json TEXT NOT NULL CHECK(json_valid(value_json)),
  command_id TEXT REFERENCES admin_commands(command_id), updated_at TEXT NOT NULL,
  PRIMARY KEY(kind,target_id)
);
INSERT INTO organizational_catalog_versions
  SELECT 'flight',u.unit_id,1,json_object('flightId',u.unit_id,'label',u.label,'squadronId',h.squadron_id,'active',json('true')),NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM organizational_units u JOIN flight_hierarchy h ON h.unit_id=u.unit_id;
INSERT INTO organizational_catalog_versions
  SELECT 'squadron',squadron_id,1,json_object('squadronId',squadron_id,'label',label),NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now') FROM squadrons;
-- Legacy source labels remain untouched. Unambiguous adopted evidence wins over today's hierarchy.
CREATE TABLE excusal_request_scopes (
  request_id TEXT PRIMARY KEY REFERENCES excusal_records(request_id),
  flight_id TEXT NOT NULL REFERENCES organizational_units(unit_id),
  squadron_id TEXT NOT NULL REFERENCES squadrons(squadron_id),
  flight_label TEXT NOT NULL, squadron_label TEXT NOT NULL,
  evidence TEXT NOT NULL CHECK(evidence IN ('submission','legacy-source','observed-migration')),
  captured_at TEXT NOT NULL
);
INSERT INTO excusal_request_scopes
  SELECT r.request_id,r.unit_id,COALESCE(legacy.squadron_id,current.squadron_id),
    CASE WHEN legacy.squadron_id IS NOT NULL AND length(trim(COALESCE(json_extract(a.evidence_json,'$.record.flight'),'')))>0
      THEN json_extract(a.evidence_json,'$.record.flight') ELSE u.label END,
    COALESCE(legacy.label,current.label),CASE WHEN legacy.squadron_id IS NOT NULL THEN 'legacy-source' ELSE 'observed-migration' END,
    strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM excusal_records r JOIN organizational_units u ON u.unit_id=r.unit_id
  LEFT JOIN flight_hierarchy h ON h.unit_id=r.unit_id LEFT JOIN squadrons current ON current.squadron_id=h.squadron_id
  LEFT JOIN legacy_operational_adoption_rows a ON a.adoption_id=r.legacy_adoption_id AND a.source_occurrence_id=r.legacy_occurrence_id AND a.kind='excusal' AND a.disposition='adopted'
  LEFT JOIN squadrons legacy ON lower(trim(legacy.label))=lower(trim(json_extract(a.evidence_json,'$.record.squadron')))
    AND (SELECT COUNT(*) FROM squadrons match WHERE lower(trim(match.label))=lower(trim(json_extract(a.evidence_json,'$.record.squadron'))))=1;
CREATE INDEX excusal_scope_squadron ON excusal_request_scopes(squadron_id,request_id);
