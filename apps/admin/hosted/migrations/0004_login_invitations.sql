-- Separate staging panel session database only. Invitations are inserted by
-- reviewed private operations, never a public enrollment endpoint.
CREATE TABLE login_invitations (
  email_sha256 TEXT PRIMARY KEY CHECK(length(email_sha256)=64 AND email_sha256 NOT GLOB '*[^0-9a-f]*'),
  principal_id TEXT NOT NULL,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL CHECK(expires>created AND expires-created<=86400000),
  consumed_subject TEXT,
  consumed_at INTEGER,
  CHECK((consumed_subject IS NULL AND consumed_at IS NULL)
    OR (consumed_subject IS NOT NULL AND length(consumed_subject) BETWEEN 1 AND 255 AND consumed_at IS NOT NULL))
);
