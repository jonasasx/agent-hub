ALTER TABLE users DROP COLUMN IF EXISTS last_codex_subscription_id;
ALTER TABLE subscriptions DROP COLUMN IF EXISTS provider;
