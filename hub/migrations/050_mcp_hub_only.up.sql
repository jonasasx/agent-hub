-- mcp-hub-only D1: the import state of a machine replaces the manual registry toggle.
ALTER TABLE runners ADD COLUMN mcp_import_state text NOT NULL DEFAULT 'done' CHECK (mcp_import_state IN ('auto-pending', 'done'));
ALTER TABLE runners ADD COLUMN mcp_imported_at timestamptz;
ALTER TABLE runners ADD COLUMN mcp_import_report jsonb;
UPDATE runners SET mcp_import_state = CASE WHEN mcp_registry_enabled THEN 'done' ELSE 'auto-pending' END;
UPDATE runners SET mcp_imported_at = now() WHERE mcp_registry_enabled;
ALTER TABLE runners DROP COLUMN mcp_registry_enabled;
-- D2: a server switched off or configured differently on one machine.
CREATE TABLE mcp_registry_machine_overrides (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_id uuid NOT NULL REFERENCES mcp_registry_servers(id) ON DELETE CASCADE,
  runner_id text NOT NULL REFERENCES runners(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  config jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, runner_id)
);
CREATE INDEX mcp_registry_machine_overrides_runner ON mcp_registry_machine_overrides (runner_id);
ALTER TABLE mcp_secrets ADD COLUMN machine_id text REFERENCES runners(id) ON DELETE CASCADE;
