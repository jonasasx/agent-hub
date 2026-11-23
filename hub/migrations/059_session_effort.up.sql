-- change `session-effort` (design D2): the effort level of a session; null — the model's default.
ALTER TABLE sessions ADD COLUMN effort text;
