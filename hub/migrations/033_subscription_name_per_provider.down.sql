DROP INDEX IF EXISTS subscriptions_active_name;
CREATE UNIQUE INDEX subscriptions_active_name ON subscriptions (user_id, lower(name)) WHERE retired_at IS NULL;
