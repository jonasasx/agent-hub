-- Change keycloak-auth (design D5–D7): one OIDC provider. Users of the new provider are `oidc`; Google and Keycloak users
-- move to it by verified email on their first login. `source` tells how a user came: before the change, invite or signup.
ALTER TABLE users DROP CONSTRAINT users_provider_check;
ALTER TABLE users ADD CONSTRAINT users_provider_check CHECK (provider IN ('google', 'keycloak', 'oidc'));
ALTER TABLE users ADD COLUMN source text NOT NULL DEFAULT 'legacy' CHECK (source IN ('legacy', 'invite', 'signup'));

-- An invite of the single-provider mode is bound to the address only.
ALTER TABLE invites ALTER COLUMN provider DROP NOT NULL;

-- id_token of the login: id_token_hint of the provider's end_session_endpoint on «Выйти» (D7).
ALTER TABLE auth_sessions ADD COLUMN id_token text;

ALTER TABLE security_events DROP CONSTRAINT security_events_kind_check;
ALTER TABLE security_events ADD CONSTRAINT security_events_kind_check
  CHECK (kind IN ('login', 'login_denied', 'logout_all', 'runner_connected', 'runner_disconnected', 'enroll_code_issued', 'enroll_code_used', 'signup'));
