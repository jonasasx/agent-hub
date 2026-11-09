-- change web-push-notifications D5: Web Push subscriptions of the devices of a user
CREATE TABLE push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE,
  endpoint_hash text NOT NULL,
  p256dh text NOT NULL,
  auth text NOT NULL,
  device_label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_success_at timestamptz,
  last_failure_at timestamptz,
  last_failure_status integer,
  failure_count integer NOT NULL DEFAULT 0
);
CREATE INDEX push_subscriptions_user ON push_subscriptions(user_id);
CREATE UNIQUE INDEX push_subscriptions_user_hash ON push_subscriptions(user_id, endpoint_hash);
