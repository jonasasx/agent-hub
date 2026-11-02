-- M1: users, browser sessions, runners (design.md D6).

CREATE TABLE users (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth_sessions (
  id_hash     bytea PRIMARY KEY,               -- sha256 of the cookie value
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  user_agent  text
);
CREATE INDEX auth_sessions_expires_at_idx ON auth_sessions (expires_at);

CREATE TABLE runners (
  id                text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  user_id           uuid NOT NULL REFERENCES users (id),
  name              text NOT NULL,
  kind              text NOT NULL DEFAULT 'machine' CHECK (kind IN ('machine', 'k8s')),
  os                text,
  hostname          text UNIQUE,
  home_dir          text,
  vault_root        text,
  token_hash        bytea,                     -- sha256 of the agent token
  is_utility        boolean NOT NULL DEFAULT false,
  online            boolean NOT NULL DEFAULT false,
  last_seen_at      timestamptz,
  agent_version     text,
  sdk_version       text,
  claude_version    text,
  protocol_version  text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX runners_user_id_idx ON runners (user_id);
