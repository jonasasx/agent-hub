-- change `hub-subagents` (design D5): parent messages that reached a child inside a running turn; each owes a report of its own turn.
ALTER TABLE sessions ADD COLUMN report_queued smallint NOT NULL DEFAULT 0;
