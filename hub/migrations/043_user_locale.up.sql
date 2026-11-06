-- change i18n D4: the interface language chosen in the profile; NULL — the browser language. The list lives in code (zod).
ALTER TABLE user_preferences ADD COLUMN locale text;
