-- Separate administrator-session database. Never apply to the operational D1 database.
CREATE TABLE panel_schema (version INTEGER PRIMARY KEY CHECK(version=1),sha256 TEXT NOT NULL,database_id TEXT NOT NULL,worker_name TEXT NOT NULL,origin TEXT NOT NULL,source_commit TEXT NOT NULL);
CREATE TABLE identity_bindings (
  google_sub TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1))
);
CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  browser_hash TEXT NOT NULL,
  verifier TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX oauth_states_expiry ON oauth_states(expires);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  google_sub TEXT NOT NULL,
  csrf TEXT NOT NULL,
  expires INTEGER NOT NULL,
  FOREIGN KEY(google_sub) REFERENCES identity_bindings(google_sub)
);
CREATE INDEX sessions_expiry ON sessions(expires);
CREATE INDEX sessions_subject ON sessions(google_sub);
CREATE TABLE auth_limits (bucket TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE INDEX auth_limits_expiry ON auth_limits(expires);
CREATE TABLE proposals (
  id TEXT PRIMARY KEY,binding TEXT NOT NULL,principal TEXT NOT NULL,
  command TEXT NOT NULL,summary TEXT NOT NULL,created INTEGER NOT NULL,
  state TEXT NOT NULL,result TEXT,
  lease_token TEXT,lease_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX proposals_principal ON proposals(binding,principal,created DESC);
CREATE INDEX proposals_retention ON proposals(state,created);
