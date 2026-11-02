-- change `provider-parity`: a subscription name is unique among the active subscriptions of one provider.
DROP INDEX IF EXISTS subscriptions_active_name;
CREATE UNIQUE INDEX subscriptions_active_name ON subscriptions (user_id, provider, lower(name)) WHERE retired_at IS NULL;
