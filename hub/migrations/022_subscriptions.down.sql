DROP TABLE IF EXISTS session_turns;
ALTER TABLE sessions DROP COLUMN IF EXISTS subscription_id;
ALTER TABLE users DROP COLUMN IF EXISTS last_subscription_id;
DROP TABLE IF EXISTS subscriptions;
