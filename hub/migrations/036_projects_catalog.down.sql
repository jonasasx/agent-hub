DROP TABLE IF EXISTS session_projects;
DROP TABLE IF EXISTS user_preferences;
DROP TABLE IF EXISTS project_bindings;
DROP TABLE IF EXISTS catalog_projects;
ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_user_id_id_key;
ALTER TABLE runners DROP CONSTRAINT IF EXISTS runners_user_id_id_key;
