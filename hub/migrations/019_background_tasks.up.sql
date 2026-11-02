-- Sleep and background work (fix «засыпание убивает субагентов»): background commands of a session (Bash/PowerShell
-- with run_in_background). Started by the tool result «Command running in background with ID: <id>», ended by the
-- <task-notification> with the same tool-use-id. While one runs, the idle timer of the session does not apply.
CREATE TABLE background_tasks (
  session_id   uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  tool_use_id  text NOT NULL,
  task_id      text,
  state        text NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'completed', 'failed', 'stopped')),
  -- timestamps of transcript lines (runner clock)
  started_at   timestamptz,
  ended_at     timestamptz,
  PRIMARY KEY (session_id, tool_use_id)
);
CREATE INDEX background_tasks_running_idx ON background_tasks (session_id) WHERE state = 'running';
