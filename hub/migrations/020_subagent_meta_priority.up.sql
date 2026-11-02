-- QA subagents: (1) meta.json of a subagent whose session the hub does not know yet waits here instead of being
-- dropped (the agent re-sends meta only for 24 h, so history lost parent, type and description); (2) from_call — the
-- row has the call (Agent/Task tool_use) in a transcript: only then the transcript beats meta.json in type,
-- description and parent; a row known from its own file only takes them from meta.json.
CREATE TABLE pending_agent_meta (
  runner_id          text NOT NULL REFERENCES runners (id) ON DELETE CASCADE,
  claude_session_id  uuid NOT NULL,
  agent_id           text NOT NULL,
  meta               jsonb NOT NULL,
  received_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (runner_id, claude_session_id, agent_id)
);
ALTER TABLE subagent_runs ADD COLUMN from_call boolean NOT NULL DEFAULT false;
-- Rows taken in before: false until subagents:backfill scans the transcripts again (a call sets it); meta.json and the
-- call carry the same type and description, so the order does not matter for them.
