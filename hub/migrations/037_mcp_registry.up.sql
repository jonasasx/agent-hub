CREATE TABLE mcp_registry_servers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  config jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);
CREATE TABLE mcp_registry_meta (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE mcp_registry_overrides (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  server_id uuid NOT NULL REFERENCES mcp_registry_servers(id) ON DELETE CASCADE,
  enabled boolean,
  config jsonb,
  revision bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, project_id, server_id)
);
CREATE TABLE mcp_secrets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_id uuid REFERENCES mcp_registry_servers(id) ON DELETE CASCADE,
  name text NOT NULL,
  ciphertext bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE mcp_registry_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  runner_id text REFERENCES runners(id) ON DELETE SET NULL,
  session_id uuid,
  name text NOT NULL,
  state text NOT NULL CHECK (state IN ('draft','validating','checked','validation-failed','needs-secret','connected','saved-unchecked')),
  config jsonb NOT NULL,
  validation jsonb,
  revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE mcp_registry_session_updates (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  runner_id text NOT NULL REFERENCES runners(id) ON DELETE CASCADE,
  session_id uuid NOT NULL,
  server_id uuid NOT NULL REFERENCES mcp_registry_servers(id) ON DELETE CASCADE,
  revision bigint NOT NULL,
  activation text NOT NULL CHECK (activation IN ('connected-live','available-next-thread','deferred')),
  applied boolean NOT NULL,
  error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, revision)
);
CREATE TABLE mcp_registry_imports (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  runner_id text NOT NULL REFERENCES runners(id) ON DELETE CASCADE,
  preview jsonb NOT NULL,
  state text NOT NULL DEFAULT 'preview' CHECK (state IN ('preview','committed','expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '24 hours'
);
ALTER TABLE mcp_secrets ADD COLUMN draft_id uuid REFERENCES mcp_registry_drafts(id) ON DELETE CASCADE;
ALTER TABLE mcp_secrets ADD COLUMN import_id uuid REFERENCES mcp_registry_imports(id) ON DELETE CASCADE;
CREATE TABLE mcp_oauth_tokens (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_id uuid NOT NULL REFERENCES mcp_registry_servers(id) ON DELETE CASCADE,
  machine_id text NOT NULL REFERENCES runners(id) ON DELETE CASCADE,
  ciphertext bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, server_id)
);
CREATE TABLE mcp_gateway_statuses (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  server_id uuid NOT NULL REFERENCES mcp_registry_servers(id) ON DELETE CASCADE,
  machine_id text NOT NULL REFERENCES runners(id) ON DELETE CASCADE,
  session_id uuid,
  status text NOT NULL CHECK (status IN ('stopped','starting','ready','needs-secret','failed')),
  endpoint text,
  error text,
  observed_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX mcp_gateway_status_scope_uq ON mcp_gateway_statuses(server_id, machine_id, COALESCE(session_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE TABLE mcp_registry_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor text NOT NULL,
  action text NOT NULL,
  server_id uuid,
  draft_id uuid,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mcp_registry_drafts_owner_idx ON mcp_registry_drafts(user_id, updated_at DESC);
CREATE INDEX mcp_gateway_status_machine_idx ON mcp_gateway_statuses(machine_id, observed_at DESC);
