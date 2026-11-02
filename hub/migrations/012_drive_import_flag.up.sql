-- Review M3c: the Drive import is a flag of the session, not its source. The source is computed by D5 with the
-- order "... -> cron -> drive_import", so a headless run imported from Drive is cron (read-only), not «импорт Drive».
ALTER TABLE sessions ADD COLUMN is_drive_import boolean NOT NULL DEFAULT false;
UPDATE sessions SET is_drive_import = true WHERE source = 'drive_import' OR origin_source = 'drive_import';
