-- change `hub-subagents` (design D3): a child hub session started by session_spawn and the report its turn owes the parent.
ALTER TABLE sessions ADD COLUMN spawned_by uuid REFERENCES sessions (id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN report_to_session_id uuid REFERENCES sessions (id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN report_since timestamptz;
CREATE INDEX sessions_spawned_by_idx ON sessions (spawned_by) WHERE spawned_by IS NOT NULL;
ALTER TABLE peer_messages ADD COLUMN kind text NOT NULL DEFAULT 'message' CHECK (kind IN ('message', 'spawn', 'report'));
