DROP TABLE IF EXISTS mcp_oauth_statuses;
UPDATE mcp_registry_drafts SET state = 'validation-failed' WHERE state = 'needs_auth';
ALTER TABLE mcp_registry_drafts DROP CONSTRAINT mcp_registry_drafts_state_check;
ALTER TABLE mcp_registry_drafts ADD CONSTRAINT mcp_registry_drafts_state_check
  CHECK (state IN ('draft','validating','checked','validation-failed','needs-secret','connected','saved-unchecked'));
