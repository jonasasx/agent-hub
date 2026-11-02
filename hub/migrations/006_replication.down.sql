-- Back to the schema of 005. Files without a session (M3 replication) are dropped: M2 keeps files of sessions only.
DROP TABLE IF EXISTS path_touches;
DROP TABLE IF EXISTS uploads;
DROP TABLE IF EXISTS blobs;
DROP INDEX IF EXISTS events_tsv_idx;
ALTER TABLE events DROP COLUMN IF EXISTS tsv;
ALTER TABLE events DROP COLUMN IF EXISTS search_text;

DELETE FROM transcript_files WHERE session_id IS NULL;
DROP INDEX IF EXISTS transcript_files_claude_idx;
DROP INDEX IF EXISTS transcript_files_session_idx;
DROP INDEX IF EXISTS transcript_files_runner_rel_key_idx;
ALTER TABLE transcript_files ALTER COLUMN session_id SET NOT NULL;
ALTER TABLE transcript_files ADD CONSTRAINT transcript_files_session_id_rel_path_key UNIQUE (session_id, rel_path);
ALTER TABLE transcript_files
  DROP COLUMN raw_merged_at,
  DROP COLUMN raw_segments,
  DROP COLUMN rel_key,
  DROP COLUMN claude_session_id,
  DROP COLUMN runner_id;

ALTER TABLE sessions DROP COLUMN cron_marker, DROP COLUMN seen_human, DROP COLUMN seen_sdk_cli, DROP COLUMN seen_cli;
ALTER TABLE sessions DROP CONSTRAINT sessions_source_check;
UPDATE sessions SET source = 'terminal' WHERE source = 'desktop';
UPDATE sessions SET source = 'remote_control' WHERE remote_control AND source = 'terminal';
ALTER TABLE sessions DROP COLUMN remote_control;
ALTER TABLE sessions ADD CONSTRAINT sessions_source_check
  CHECK (source IN ('hub', 'terminal', 'orca', 'remote_control', 'cron', 'drive_import'));
