UPDATE sessions SET source = 'desktop' WHERE source = 'sdk';
UPDATE sessions SET origin_source = 'desktop' WHERE origin_source = 'sdk';
ALTER TABLE sessions DROP CONSTRAINT sessions_source_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_source_check
  CHECK (source IN ('hub', 'terminal', 'orca', 'desktop', 'cron', 'drive_import'));
ALTER TABLE sessions DROP CONSTRAINT sessions_origin_source_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_origin_source_check
  CHECK (origin_source IS NULL OR origin_source IN ('hub', 'terminal', 'orca', 'desktop', 'cron', 'drive_import'));
ALTER TABLE sessions DROP COLUMN seen_human_non_cli;
