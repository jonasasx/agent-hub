-- change `session-sleep-controls` (design D1): the user's default idle timeout in minutes; NULL — the hub's, 0 — never.
ALTER TABLE user_preferences ADD COLUMN idle_timeout_min integer;
