-- fix «finished background task counted as running»: the <task-notification> of a task can be read before its call and
-- its result (the main transcript and the file of the subagent that made the call are scanned in any order). The end is
-- kept on the `pending` row (or on a row made by the notification) and applied when the result names the task.
ALTER TABLE background_tasks ADD COLUMN early_end text CHECK (early_end IN ('completed', 'failed', 'stopped'));
