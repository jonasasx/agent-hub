-- provider-parity R7: dropping `provider` would turn the auth.json of a Codex subscription into a «Claude token»;
-- the rollback refuses while Codex subscriptions exist.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM subscriptions WHERE provider = 'codex') THEN
    RAISE EXCEPTION '032 down is not supported while Codex subscriptions exist; delete them first';
  END IF;
END $$;
ALTER TABLE users DROP COLUMN IF EXISTS last_codex_subscription_id;
ALTER TABLE subscriptions DROP COLUMN IF EXISTS provider;
