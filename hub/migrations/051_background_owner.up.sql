-- fix «фоновые задачи субагента навсегда running»: Claude Code ends the background commands and monitors of a subagent
-- with its final response and writes no notification. The subagent (agentId) whose transcript made the call is kept on
-- the row; the end of that subagent ends its running tasks. NULL — a task of the session's main transcript.
ALTER TABLE background_tasks ADD COLUMN agent_id text;
CREATE INDEX background_tasks_agent ON background_tasks (session_id, agent_id) WHERE agent_id IS NOT NULL;
