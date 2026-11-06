-- Delivery remains suppressed in hosted staging. No mail transport is configured.
CREATE TABLE notification_delivery_control (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  mode TEXT NOT NULL CHECK(mode IN ('suppressed','local-test')),
  daily_recipient_budget INTEGER NOT NULL CHECK(daily_recipient_budget BETWEEN 0 AND 500),
  max_ledger_entries INTEGER NOT NULL CHECK(max_ledger_entries BETWEEN 1 AND 10000)
);
INSERT INTO notification_delivery_control SELECT 1,'suppressed',0,1000;
CREATE TABLE notification_intents (
  notice_id TEXT PRIMARY KEY, notice_key TEXT NOT NULL UNIQUE, policy_version TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('event-day','weekly-review','excusal-submitted','excusal-decision')),
  scope_id TEXT NOT NULL, local_date TEXT NOT NULL,
  environment TEXT NOT NULL CHECK(environment IN ('local','staging')), generation INTEGER NOT NULL CHECK(generation>0),
  mode TEXT NOT NULL CHECK(mode IN ('staging','local-test')),
  state TEXT NOT NULL CHECK(state IN ('queued','sending','sent','blocked','suppressed','uncertain')),
  blocked_reason TEXT, to_json TEXT NOT NULL, cc_json TEXT NOT NULL, reply_to TEXT,
  subject TEXT NOT NULL, body TEXT NOT NULL, payload_hash TEXT NOT NULL, recipe_json TEXT NOT NULL,
  recipient_count INTEGER NOT NULL CHECK(recipient_count>=0),
  origin_command_id TEXT NOT NULL REFERENCES command_registry(command_id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX notification_state_created ON notification_intents(state,created_at,notice_id);
CREATE TABLE notification_attempts (
  attempt_id TEXT PRIMARY KEY, notice_id TEXT NOT NULL REFERENCES notification_intents(notice_id),
  principal_id TEXT NOT NULL REFERENCES principals(principal_id), worker_id TEXT NOT NULL,
  local_date TEXT NOT NULL, recipient_count INTEGER NOT NULL CHECK(recipient_count>0),
  state TEXT NOT NULL CHECK(state IN ('sending','sent','known-not-sent','uncertain')),
  started_at TEXT NOT NULL, expires_at TEXT NOT NULL, finished_at TEXT, provider_reference TEXT,
  result_code TEXT
);
CREATE INDEX notification_attempt_notice ON notification_attempts(notice_id,started_at);
CREATE INDEX notification_attempt_budget ON notification_attempts(local_date,recipient_count);
CREATE INDEX notification_attempt_expiry ON notification_attempts(state,expires_at);
CREATE TABLE notification_delivery_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT, notice_id TEXT NOT NULL REFERENCES notification_intents(notice_id),
  attempt_id TEXT REFERENCES notification_attempts(attempt_id), action TEXT NOT NULL,
  principal_id TEXT NOT NULL REFERENCES principals(principal_id), accepted_at TEXT NOT NULL,
  previous_state TEXT NOT NULL, state TEXT NOT NULL
);
