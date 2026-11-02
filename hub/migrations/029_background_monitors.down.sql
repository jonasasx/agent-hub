DROP INDEX IF EXISTS background_tasks_task_idx;
DELETE FROM background_tasks WHERE state = 'pending';
UPDATE background_tasks SET state = 'stopped' WHERE state = 'expired';
ALTER TABLE background_tasks DROP CONSTRAINT background_tasks_state_check;
ALTER TABLE background_tasks ADD CONSTRAINT background_tasks_state_check
  CHECK (state IN ('running', 'completed', 'failed', 'stopped'));
ALTER TABLE background_tasks
  DROP COLUMN kind, DROP COLUMN description, DROP COLUMN command, DROP COLUMN timeout_ms,
  DROP COLUMN persistent, DROP COLUMN last_event_at, DROP COLUMN last_event;
