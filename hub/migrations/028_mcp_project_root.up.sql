-- mcp-management (QA fix 3): the project a session's MCP disable is kept under (snapshot `projectRoot`, agent 0.2.5+).
-- Only adds: an older hub image runs on this schema.
ALTER TABLE sessions ADD COLUMN mcp_project_root text;
