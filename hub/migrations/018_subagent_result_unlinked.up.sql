-- Change `subagents`, review p. 2 and p. 7: when the result of a call came (a call with its result waits for no
-- transcript by the prompt), and the partial index of the metric agenthub_subagent_unlinked.
ALTER TABLE subagent_runs ADD COLUMN result_at timestamptz;
CREATE INDEX subagent_runs_unlinked_idx ON subagent_runs (id) WHERE file_id IS NOT NULL AND tool_use_id IS NULL AND meta IS NULL;
