-- claude-subscriptions QA B2: the version of the token (subscriptions.token_updated_at) the current (last) hub process of
-- the session was launched with. A 401 of a process that got an older token does not mark the replaced token as
-- rejected; a message to such a process restarts it with the current token. NULL — unknown (launched before this
-- column, or the machine login). Only adds: an older hub image runs on this schema.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS subscription_token_at timestamptz;
