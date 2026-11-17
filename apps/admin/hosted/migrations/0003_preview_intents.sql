-- Add only to the staging panel session database after 0002.
-- Retain request IDs before contacting the separate operational audit service.
CREATE TABLE session_preview_intents (
  token_hash TEXT PRIMARY KEY REFERENCES sessions(token_hash) ON DELETE CASCADE,
  person_id TEXT NOT NULL,
  entry_audit_id TEXT NOT NULL,
  exit_audit_id TEXT
);
