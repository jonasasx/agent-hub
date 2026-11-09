DELETE FROM background_tasks WHERE state = 'pending' AND early_end IS NOT NULL AND description IS NULL AND command IS NULL;
ALTER TABLE background_tasks DROP COLUMN early_end;
