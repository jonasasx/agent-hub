-- change `agent-providers` (design D3): the vendor of a session, fixed at creation; the providers a machine reported.
ALTER TABLE sessions ADD COLUMN provider text NOT NULL DEFAULT 'claude' CHECK (provider IN ('claude', 'codex'));
ALTER TABLE runners ADD COLUMN providers jsonb;
