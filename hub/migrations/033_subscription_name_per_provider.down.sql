-- provider-parity R7: the per-user unique index cannot hold when a Claude and a Codex subscription share a name;
-- the rollback refuses instead of failing halfway or renaming user data.
DO $$
DECLARE
  duplicates text;
BEGIN
  SELECT string_agg(DISTINCT lower(name), ', ') INTO duplicates
  FROM (
    SELECT user_id, lower(name) AS name FROM subscriptions WHERE retired_at IS NULL GROUP BY user_id, lower(name) HAVING count(*) > 1
  ) d;
  IF duplicates IS NOT NULL THEN
    RAISE EXCEPTION '033 down is not supported: active subscriptions of different providers share names (%); rename or retire them first', duplicates;
  END IF;
END $$;
DROP INDEX IF EXISTS subscriptions_active_name;
CREATE UNIQUE INDEX subscriptions_active_name ON subscriptions (user_id, lower(name)) WHERE retired_at IS NULL;
