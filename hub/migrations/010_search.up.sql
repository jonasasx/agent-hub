-- Ctrl+K (task 3.9, design D6): trigram indexes for the title and the directory (the project until M4);
-- the text of messages already has events_tsv_idx (006).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX sessions_title_trgm_idx ON sessions USING gin (title gin_trgm_ops);
CREATE INDEX sessions_cwd_trgm_idx ON sessions USING gin (cwd gin_trgm_ops);
