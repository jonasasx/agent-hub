-- Review M3a.
-- (1) Files replicated in M2 (hub sessions) have events but no raw segments in S3: a restore would find a gap at
-- line 0. Their cursors go back to 0, so the agent sends them again: events are kept (ON CONFLICT DO NOTHING), the
-- raw copy becomes complete (design D4).
UPDATE transcript_files
   SET acked_line = 0, acked_byte = 0
 WHERE raw_segments = 0 AND raw_merged_at IS NULL AND acked_line > 0;
-- (2) The source a session had before the hub resumed it (terminal, Orca, desktop…): `source` becomes 'hub' then,
-- the UI keeps showing where the session came from (D5).
ALTER TABLE sessions ADD COLUMN origin_source text
  CHECK (origin_source IS NULL OR origin_source IN ('hub', 'terminal', 'orca', 'desktop', 'cron', 'drive_import'));
UPDATE sessions SET origin_source = source;
