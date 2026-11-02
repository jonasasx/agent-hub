-- subscription-limits (design L4): one snapshot of limits per subscription (not a history). Windows come from session
-- events (limits.event) and probe turns (limits.probe); `last_quiet_at` — a successful turn without a rate_limit_event
-- (below the service's warning thresholds). No token here. Only adds: an older hub image runs on this schema.
-- Review A6: the row's owner is the subscription's owner — a composite FK on (id, user_id), which needs a unique key
-- on subscriptions (id alone is the primary key, so (id, user_id) is unique anyway: the constraint only names it).
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_id_user_key UNIQUE (id, user_id);
CREATE TABLE subscription_limits (
  subscription_id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- review A5: the token version (subscriptions.token_updated_at) the snapshot belongs to; a row of another version
  -- (the token replaced by an older hub image that does not know this table) is reset on the next write, ignored on read
  token_at timestamptz NOT NULL,
  -- [{type, utilization, resetsAt, status, surpassedThreshold, observedAt, source}]
  windows jsonb NOT NULL DEFAULT '[]',
  overage jsonb,
  last_ok_at timestamptz,
  last_quiet_at timestamptz,
  last_probe_at timestamptz,
  probe_outcome text CHECK (probe_outcome IN ('ok', 'no_event', 'limit', 'auth_rejected', 'account_unavailable', 'failed', 'no_runner', 'agent_outdated')),
  -- a short code or text, ≤200 characters, never the token
  probe_error text CHECK (char_length(probe_error) <= 200),
  probe_failures integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscription_limits_owner_fkey FOREIGN KEY (subscription_id, user_id) REFERENCES subscriptions (id, user_id) ON DELETE CASCADE
);
CREATE INDEX subscription_limits_user ON subscription_limits (user_id);
