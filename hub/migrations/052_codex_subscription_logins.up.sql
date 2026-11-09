-- change `provider-parity` (design R5, R6): a sign-in for a Codex subscription survives a hub restart and expires.
CREATE TABLE codex_subscription_logins (
  login_id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  runner_id text NOT NULL REFERENCES runners(id) ON DELETE CASCADE,
  name text,
  subscription_id uuid REFERENCES subscriptions(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX codex_subscription_logins_expires ON codex_subscription_logins (expires_at);
