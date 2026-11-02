-- The reset cursors are not restored (the agent has re-sent those lines).
ALTER TABLE sessions DROP COLUMN origin_source;
