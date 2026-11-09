ALTER TABLE mcp_secrets DROP COLUMN IF EXISTS machine_id;
DROP TABLE IF EXISTS mcp_registry_machine_overrides;
ALTER TABLE runners ADD COLUMN mcp_registry_enabled boolean NOT NULL DEFAULT false;
UPDATE runners SET mcp_registry_enabled = (mcp_import_state = 'done');
ALTER TABLE runners DROP COLUMN mcp_import_report;
ALTER TABLE runners DROP COLUMN mcp_imported_at;
ALTER TABLE runners DROP COLUMN mcp_import_state;
