-- M4b review: one handoff draft in the works per session, also for concurrent requests.
-- A pending draft left by a restart mid-generation would block the index: such drafts end as errors first.
UPDATE handoff_drafts SET status = 'error', error = 'Генерация прервана перезапуском хаба', finished_at = now()
 WHERE status = 'pending';
CREATE UNIQUE INDEX handoff_drafts_pending_idx ON handoff_drafts (session_id) WHERE status = 'pending';
