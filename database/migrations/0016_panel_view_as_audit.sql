-- Read-only panel previews have their own audit ledger: no operational revision or publication effect.
CREATE TABLE panel_view_as_audit (
  audit_id TEXT PRIMARY KEY,
  entry_audit_id TEXT NOT NULL REFERENCES panel_view_as_audit(audit_id),
  action TEXT NOT NULL CHECK(action IN ('enter','exit')),
  environment TEXT NOT NULL CHECK(environment IN ('local','staging')),
  generation INTEGER NOT NULL CHECK(generation>0),
  actor_id TEXT NOT NULL REFERENCES principals(principal_id),
  target_person_id TEXT NOT NULL REFERENCES people(person_id),
  target_principal_id TEXT REFERENCES principals(principal_id),
  status TEXT NOT NULL CHECK(status IN ('ready','no-active-principal','ambiguous-principal','no-verified-login','no-panel-access','exited')),
  request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
  accepted_at TEXT NOT NULL,
  CHECK((action='enter' AND entry_audit_id=audit_id AND status<>'exited') OR (action='exit' AND status='exited'))
);
CREATE INDEX panel_view_as_entry_action ON panel_view_as_audit(entry_audit_id,action);
