-- Review 596f2d6: children (subagents, background commands) of a process that is gone must not count as working. The
-- reference is the start of the current process — set by create, resume, reconcile and a process that reports itself
-- alive again; slept_at alone missed a crash (no slept_at) and external sessions raised from the hub.
ALTER TABLE sessions ADD COLUMN process_started_at timestamptz;
UPDATE sessions SET process_started_at = COALESCE(last_input_at, created_at) WHERE process_alive;
