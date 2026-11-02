-- Change multi-user (design M1): roles and providers of users, invites, enrollment codes, the security log, Telegram
-- links; runners: hostname and name unique per owner, state, Claude login, self-update, the next token.
-- 023, not 022: change claude-subscriptions takes 022 (design M1).

ALTER TABLE users
  ADD COLUMN role          text NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
  ADD COLUMN provider      text NOT NULL DEFAULT 'google' CHECK (provider IN ('google', 'keycloak')),
  ADD COLUMN subject       text,
  ADD COLUMN name          text,
  ADD COLUMN status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  ADD COLUMN last_login_at timestamptz;
-- `sub` of the provider: the identity after the first login (the address may change at the provider).
CREATE UNIQUE INDEX users_provider_subject_key ON users (provider, subject) WHERE subject IS NOT NULL;

CREATE TABLE invites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL,
  provider    text NOT NULL CHECK (provider IN ('google', 'keycloak')),
  code_hash   bytea NOT NULL UNIQUE,            -- sha256 of the 256-bit code of the link
  created_by  uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  revoked_at  timestamptz,
  user_id     uuid REFERENCES users (id) ON DELETE SET NULL   -- the user the invite created
);
CREATE INDEX invites_email_idx ON invites (lower(email));

-- Runners: hostname was unique across the hub (001); now per owner. Names unique per owner: duplicates of the
-- single-user era get the runner id appended (there are none on the production hub, the guard is for copies).
ALTER TABLE runners DROP CONSTRAINT IF EXISTS runners_hostname_key;
CREATE UNIQUE INDEX runners_user_hostname_key ON runners (user_id, hostname);
UPDATE runners r SET name = r.name || ' (' || r.id || ')'
  WHERE EXISTS (SELECT 1 FROM runners o WHERE o.user_id = r.user_id AND o.name = r.name AND (o.created_at, o.id) < (r.created_at, r.id));
CREATE UNIQUE INDEX runners_user_name_key ON runners (user_id, name);
ALTER TABLE runners
  ADD COLUMN state             text NOT NULL DEFAULT 'active' CHECK (state IN ('pending', 'active', 'disabled')),
  ADD COLUMN claude_login      text CHECK (claude_login IN ('ok', 'missing', 'rejected')),
  ADD COLUMN protected_dirs_ok boolean,
  ADD COLUMN arch              text,
  -- {version, status: sent|waiting|installing|failed, error, at} of the latest agent.update; null — none
  ADD COLUMN update_state      jsonb,
  -- the token of the latest enrollment until the agent connects with it (design M4): both hashes work until then
  ADD COLUMN token_hash_next   bytea;

CREATE TABLE enroll_codes (
  code_hash   bytea PRIMARY KEY,                -- sha256 of the 130-bit code
  runner_id   text NOT NULL REFERENCES runners (id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  revoked_at  timestamptz,
  -- progress of the window «Подключить машину» (EnrollStage of shared/api.ts)
  stage       text NOT NULL DEFAULT 'waiting' CHECK (stage IN ('waiting', 'code_used', 'connected', 'claude_checked', 'ready'))
);
CREATE INDEX enroll_codes_runner_idx ON enroll_codes (runner_id, created_at DESC);

CREATE TABLE security_events (
  id          bigserial PRIMARY KEY,
  user_id     uuid REFERENCES users (id) ON DELETE CASCADE,   -- null: login_denied of an unknown address
  kind        text NOT NULL CHECK (kind IN ('login', 'login_denied', 'logout_all', 'runner_connected', 'runner_disconnected', 'enroll_code_issued', 'enroll_code_used')),
  ip          inet,
  user_agent  text,
  provider    text,
  email       text,                             -- login_denied: the address that was refused
  runner_id   text REFERENCES runners (id) ON DELETE SET NULL,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX security_events_user_at_idx ON security_events (user_id, at DESC);
CREATE INDEX security_events_at_idx ON security_events (at);

-- Personal notifications (design M8, tasks section 7): created now, used when the hub bot is made.
CREATE TABLE telegram_links (
  user_id    uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  chat_id    text NOT NULL,
  linked_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE telegram_link_codes (
  code_hash   bytea PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);
