ALTER TABLE runners DROP COLUMN IF EXISTS mcp_probe_at, DROP COLUMN IF EXISTS mcp_observed_at, DROP COLUMN IF EXISTS mcp_servers;
ALTER TABLE sessions DROP COLUMN IF EXISTS mcp_problems, DROP COLUMN IF EXISTS mcp_observed_at, DROP COLUMN IF EXISTS mcp_servers;
