ALTER TABLE peer_messages DROP COLUMN IF EXISTS kind;
DROP INDEX IF EXISTS sessions_spawned_by_idx;
ALTER TABLE sessions DROP COLUMN IF EXISTS report_since;
ALTER TABLE sessions DROP COLUMN IF EXISTS report_to_session_id;
ALTER TABLE sessions DROP COLUMN IF EXISTS spawned_by;
