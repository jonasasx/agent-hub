-- Sessions of qwen cannot be kept without the provider; they and the dependent rows go (the rows of the sessions cascade).
DELETE FROM sessions WHERE provider = 'qwen';
UPDATE user_preferences SET last_provider = NULL WHERE last_provider = 'qwen';
ALTER TABLE sessions DROP CONSTRAINT sessions_provider_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_provider_check CHECK (provider IN ('claude', 'codex'));
ALTER TABLE user_preferences DROP CONSTRAINT user_preferences_last_provider_check;
ALTER TABLE user_preferences ADD CONSTRAINT user_preferences_last_provider_check CHECK (last_provider IN ('claude', 'codex'));
