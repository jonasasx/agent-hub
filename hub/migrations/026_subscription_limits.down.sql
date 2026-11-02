DROP TABLE IF EXISTS subscription_limits;
ALTER TABLE subscriptions DROP CONSTRAINT IF EXISTS subscriptions_id_user_key;
