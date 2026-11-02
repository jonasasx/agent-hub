ALTER TABLE mcp_registry_drafts DROP CONSTRAINT mcp_registry_drafts_state_check;
ALTER TABLE mcp_registry_drafts ADD CONSTRAINT mcp_registry_drafts_state_check
  CHECK (state IN ('draft','validating','checked','validation-failed','needs-secret','needs_auth','connected','saved-unchecked'));

CREATE TABLE mcp_oauth_statuses (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_id uuid NOT NULL REFERENCES mcp_registry_servers(id) ON DELETE CASCADE,
  machine_id text NOT NULL REFERENCES runners(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('pending','signed-in','refresh-error','expired','failed','needs-login')),
  validation_state text NOT NULL DEFAULT 'unchecked' CHECK (validation_state IN ('unchecked','checked','needs_auth','validation-failed')),
  validated_revision bigint,
  registry_ready boolean NOT NULL DEFAULT true,
  expires_at timestamptz,
  error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, server_id, machine_id)
);
