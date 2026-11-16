-- change `qwen-provider` (design D6): the provider `qwen` (an OpenAI-compatible endpoint) for sessions and the last chosen provider.
ALTER TABLE sessions DROP CONSTRAINT sessions_provider_check;
ALTER TABLE sessions ADD CONSTRAINT sessions_provider_check CHECK (provider IN ('claude', 'codex', 'qwen'));
ALTER TABLE user_preferences DROP CONSTRAINT user_preferences_last_provider_check;
ALTER TABLE user_preferences ADD CONSTRAINT user_preferences_last_provider_check CHECK (last_provider IN ('claude', 'codex', 'qwen'));
