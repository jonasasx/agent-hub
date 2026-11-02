-- Change `subagents` (design S1): the registry of subagents of a session, filled when the replica is taken in.
CREATE TABLE subagent_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  session_id       uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  -- agentId without the agent- prefix; NULL — a call whose agent is not known yet
  agent_id         text,
  tool_use_id      text,
  file_id          bigint REFERENCES transcript_files (id) ON DELETE SET NULL,
  -- NULL — called by the session; else agentId of the subagent that called it
  parent_agent_id  text,
  kind             text NOT NULL DEFAULT 'subagent' CHECK (kind IN ('subagent', 'teammate', 'skill')),
  description      text,
  agent_type       text,
  name             text,
  team_name        text,
  model            text,
  -- sha256 of the task text (call) or of the first message (file): the link without agentId
  prompt_sha       bytea,
  background       boolean NOT NULL DEFAULT false,
  state            text NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'idle', 'completed', 'failed', 'stopped')),
  -- timestamps of transcript lines (not the hub's clock)
  started_at       timestamptz,
  last_event_at    timestamptz,
  ended_at         timestamptz,
  state_at         timestamptz,
  duration_ms      bigint,
  total_tokens     bigint,
  tool_uses        bigint,
  meta             jsonb,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX subagent_runs_agent_idx ON subagent_runs (session_id, agent_id) WHERE agent_id IS NOT NULL;
CREATE UNIQUE INDEX subagent_runs_call_idx ON subagent_runs (session_id, tool_use_id) WHERE tool_use_id IS NOT NULL;
CREATE INDEX subagent_runs_session_idx ON subagent_runs (session_id, started_at);
CREATE INDEX subagent_runs_file_idx ON subagent_runs (file_id);
CREATE INDEX subagent_runs_prompt_idx ON subagent_runs (session_id, prompt_sha) WHERE agent_id IS NULL;

-- Kinds of tabs that are not sessions in the layout template (subagent chats, design S9): stored as the window sent them.
ALTER TABLE ui_layouts ADD COLUMN tab_kinds jsonb;
