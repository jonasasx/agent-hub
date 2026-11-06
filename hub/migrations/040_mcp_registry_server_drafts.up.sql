ALTER TABLE mcp_registry_drafts
  ADD COLUMN server_id uuid REFERENCES mcp_registry_servers(id) ON DELETE CASCADE,
  ADD COLUMN base_revision bigint;
