-- session-context-usage (design D3): the last context-window snapshot of a session, no history. The three numbers on
-- `sessions` feed SessionView of every list; the breakdown (categories, MCP, memory, skills, agents) lives in its own
-- table and is read only by GET /api/sessions/:id/context. Only adds: an older hub image runs on this schema.
ALTER TABLE sessions
  ADD COLUMN context_used integer,
  ADD COLUMN context_window integer,
  ADD COLUMN context_at timestamptz;
CREATE TABLE session_context (
  session_id uuid PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  snapshot jsonb NOT NULL,
  observed_at timestamptz NOT NULL
);
