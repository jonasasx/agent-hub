DROP TABLE IF EXISTS session_context;
ALTER TABLE sessions DROP COLUMN IF EXISTS context_at, DROP COLUMN IF EXISTS context_window, DROP COLUMN IF EXISTS context_used;
