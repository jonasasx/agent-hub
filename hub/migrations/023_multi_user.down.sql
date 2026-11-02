-- Back to the single-user schema. Users of role `user` and their runners stay (rows are not deleted); restoring the
-- global UNIQUE (hostname) fails while two owners share a hostname — remove one first.
DROP TABLE IF EXISTS telegram_link_codes;
DROP TABLE IF EXISTS telegram_links;
DROP TABLE IF EXISTS security_events;
DROP TABLE IF EXISTS enroll_codes;
DROP TABLE IF EXISTS invites;

ALTER TABLE runners
  DROP COLUMN IF EXISTS token_hash_next,
  DROP COLUMN IF EXISTS update_state,
  DROP COLUMN IF EXISTS arch,
  DROP COLUMN IF EXISTS protected_dirs_ok,
  DROP COLUMN IF EXISTS claude_login,
  DROP COLUMN IF EXISTS state;
DROP INDEX IF EXISTS runners_user_name_key;
DROP INDEX IF EXISTS runners_user_hostname_key;
ALTER TABLE runners ADD CONSTRAINT runners_hostname_key UNIQUE (hostname);

DROP INDEX IF EXISTS users_provider_subject_key;
ALTER TABLE users
  DROP COLUMN IF EXISTS last_login_at,
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS name,
  DROP COLUMN IF EXISTS subject,
  DROP COLUMN IF EXISTS provider,
  DROP COLUMN IF EXISTS role;
