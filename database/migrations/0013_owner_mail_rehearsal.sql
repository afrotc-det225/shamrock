-- Explicit owner-only rehearsal. Existing suppressed notification intents are never changed.
CREATE TABLE owner_mail_cases (
  case_id TEXT PRIMARY KEY, notice_id TEXT NOT NULL UNIQUE REFERENCES notification_intents(notice_id),
  source_hash TEXT NOT NULL, principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  environment TEXT NOT NULL CHECK(environment='staging'), generation INTEGER NOT NULL CHECK(generation>0),
  owner_email TEXT NOT NULL, message_json TEXT NOT NULL, review_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('ready','sending','sent','not-sent','uncertain')),
  prepared_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE owner_mail_attempts (
  attempt_id TEXT PRIMARY KEY, case_id TEXT NOT NULL UNIQUE REFERENCES owner_mail_cases(case_id),
  claim_id TEXT NOT NULL UNIQUE, principal_id TEXT NOT NULL REFERENCES principals(principal_id), worker_id TEXT NOT NULL,
  claim_token TEXT NOT NULL, local_date TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('sending','sent','not-sent','uncertain')),
  started_at TEXT NOT NULL, expires_at TEXT NOT NULL, finished_at TEXT, completion_hash TEXT, receipt_json TEXT
);
CREATE INDEX owner_mail_budget ON owner_mail_attempts(local_date);
CREATE TABLE owner_mail_audit (
  audit_id INTEGER PRIMARY KEY AUTOINCREMENT, case_id TEXT NOT NULL REFERENCES owner_mail_cases(case_id),
  attempt_id TEXT REFERENCES owner_mail_attempts(attempt_id), principal_id TEXT NOT NULL REFERENCES principals(principal_id),
  action TEXT NOT NULL, accepted_at TEXT NOT NULL, details_json TEXT NOT NULL
);
