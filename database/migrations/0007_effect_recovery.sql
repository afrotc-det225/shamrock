-- Immutable evidence for an explicitly reconciled refresh lease. No lease stealing.
CREATE TABLE admin_effect_recoveries (
  recovery_id TEXT PRIMARY KEY,
  effect_id TEXT NOT NULL REFERENCES admin_effects(effect_id),
  actor_id TEXT NOT NULL REFERENCES principals(principal_id),
  worker_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation>0),
  request_sha256 TEXT NOT NULL CHECK(length(request_sha256)=64),
  checkpoint_sha256 TEXT NOT NULL CHECK(length(checkpoint_sha256)=64),
  provider_state TEXT NOT NULL CHECK(provider_state IN ('before','after','partial','completed')),
  previous_expiry TEXT NOT NULL,
  renewed_expiry TEXT NOT NULL,
  created_at TEXT NOT NULL,
  receipt_json TEXT NOT NULL
);
CREATE INDEX admin_effect_recoveries_effect ON admin_effect_recoveries(effect_id,created_at);
