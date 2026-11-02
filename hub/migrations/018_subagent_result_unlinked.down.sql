DROP INDEX IF EXISTS subagent_runs_unlinked_idx;
ALTER TABLE subagent_runs DROP COLUMN IF EXISTS result_at;
