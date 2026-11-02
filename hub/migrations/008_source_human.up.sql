-- D5 fix (QA M3a): a human reply outside the CLI (desktop app on Windows, SDK clients on Linux) decides the source,
-- and `sdk` is a new source. Signals are recomputed by `cli.js sessions:reclassify` (main transcripts only).
ALTER TABLE sessions ADD COLUMN seen_human_non_cli boolean NOT NULL DEFAULT false;
ALTER TABLE sessions DROP CONSTRAINT sessions_source_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_source_check
  CHECK (source IN ('hub', 'terminal', 'orca', 'desktop', 'sdk', 'cron', 'drive_import'));
ALTER TABLE sessions DROP CONSTRAINT sessions_origin_source_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_origin_source_check
  CHECK (origin_source IS NULL OR origin_source IN ('hub', 'terminal', 'orca', 'desktop', 'sdk', 'cron', 'drive_import'));
