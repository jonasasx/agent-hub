-- change `background-tasks` (design D1): monitors (Monitor) next to background commands, the call's metadata, the last
-- event of a monitor. A call makes a `pending` row (not shown, not working); its result with the task id makes it
-- `running`. A monitor past started_at + timeout_ms is `expired` (no transcript marker: the hub's sweep sets it).
ALTER TABLE background_tasks
  ADD COLUMN kind          text NOT NULL DEFAULT 'bash' CHECK (kind IN ('bash', 'monitor')),
  ADD COLUMN description   text,
  ADD COLUMN command       text,
  ADD COLUMN timeout_ms    bigint,
  ADD COLUMN persistent    boolean NOT NULL DEFAULT false,
  ADD COLUMN last_event_at timestamptz,
  ADD COLUMN last_event    text;
ALTER TABLE background_tasks DROP CONSTRAINT background_tasks_state_check;
ALTER TABLE background_tasks ADD CONSTRAINT background_tasks_state_check
  CHECK (state IN ('pending', 'running', 'completed', 'failed', 'stopped', 'expired'));
CREATE INDEX background_tasks_task_idx ON background_tasks (session_id, task_id);
