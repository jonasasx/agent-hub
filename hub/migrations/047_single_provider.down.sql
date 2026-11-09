-- Back to two providers: provider-less invites have no place in the old schema and are removed.
DELETE FROM security_events WHERE kind = 'signup';
ALTER TABLE security_events DROP CONSTRAINT security_events_kind_check;
ALTER TABLE security_events ADD CONSTRAINT security_events_kind_check
  CHECK (kind IN ('login', 'login_denied', 'logout_all', 'runner_connected', 'runner_disconnected', 'enroll_code_issued', 'enroll_code_used'));
ALTER TABLE auth_sessions DROP COLUMN id_token;
DELETE FROM invites WHERE provider IS NULL;
ALTER TABLE invites ALTER COLUMN provider SET NOT NULL;
ALTER TABLE users DROP COLUMN source;
-- `oidc` users keep their data: they become Google users without `sub`, the old login binds them again by address.
UPDATE users SET provider = 'google', subject = NULL WHERE provider = 'oidc';
ALTER TABLE users DROP CONSTRAINT users_provider_check;
ALTER TABLE users ADD CONSTRAINT users_provider_check CHECK (provider IN ('google', 'keycloak'));
