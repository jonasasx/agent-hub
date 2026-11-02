-- claude-subscriptions (design P2): the registry of Claude subscriptions with encrypted `claude setup-token` tokens, the
-- user's last choice, the subscription of a session's current (last) hub process, and one row per finished turn for
-- the usage screen. Only adds: an older hub image runs on this schema.
CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  -- AES-256-GCM: iv(12) ‖ tag(16) ‖ ciphertext, AAD = id (hub/src/subscriptions/crypto.ts)
  token_enc bytea NOT NULL,
  -- the last 4 characters of the token, the only part shown
  token_hint text NOT NULL,
  position integer NOT NULL,
  auto_switch boolean NOT NULL DEFAULT false,
  retired_at timestamptz,
  -- the limit is exhausted until this time
  limit_resets_at timestamptz,
  -- rateLimitType of the last limit (five_hour, seven_day, …)
  limit_kind text,
  -- auth_rejected; cleared by a token replacement
  token_rejected_at timestamptz,
  token_updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX subscriptions_active_name ON subscriptions (user_id, lower(name)) WHERE retired_at IS NULL;
CREATE INDEX subscriptions_user_position ON subscriptions (user_id, position);

ALTER TABLE users ADD COLUMN last_subscription_id uuid REFERENCES subscriptions(id) ON DELETE SET NULL;
-- the subscription of the current (last) hub process; NULL — the machine login
ALTER TABLE sessions ADD COLUMN subscription_id uuid REFERENCES subscriptions(id) ON DELETE SET NULL;

CREATE TABLE session_turns (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL,
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  runner_id text NOT NULL,
  subscription_id uuid REFERENCES subscriptions(id) ON DELETE SET NULL,
  ended_at timestamptz NOT NULL,
  is_error boolean NOT NULL,
  failure text CHECK (failure IN ('subscription_limit', 'auth_rejected', 'account_unavailable')),
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  cache_read_tokens bigint NOT NULL DEFAULT 0,
  cache_creation_tokens bigint NOT NULL DEFAULT 0
);
CREATE INDEX session_turns_user_ended ON session_turns (user_id, ended_at);
