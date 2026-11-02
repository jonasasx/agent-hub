-- mcp-management (design M6): the last MCP snapshot of a session's process and the user-config servers of a machine.
-- Not a history: one snapshot each, written only when newer. No secrets inside (the agent redacts them, M5).
-- `mcp_problems` — the count of `failed` + `needs-auth` servers, computed on write (SessionView, the sidebar).
-- Only adds: an older hub image runs on this schema.
ALTER TABLE sessions
  ADD COLUMN mcp_servers jsonb,
  ADD COLUMN mcp_observed_at timestamptz,
  ADD COLUMN mcp_problems smallint NOT NULL DEFAULT 0;
ALTER TABLE runners
  ADD COLUMN mcp_servers jsonb,
  ADD COLUMN mcp_observed_at timestamptz,
  ADD COLUMN mcp_probe_at timestamptz;
