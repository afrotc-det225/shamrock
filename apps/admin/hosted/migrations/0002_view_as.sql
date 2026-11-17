-- Apply only to the separate staging administrator-session database.
-- Existing sessions and verified identity bindings are unchanged.
CREATE TABLE session_previews (
  token_hash TEXT PRIMARY KEY REFERENCES sessions(token_hash) ON DELETE CASCADE,
  person_id TEXT NOT NULL,
  entry_audit_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ready','no-active-principal','ambiguous-principal','no-verified-login','no-panel-access'))
);
