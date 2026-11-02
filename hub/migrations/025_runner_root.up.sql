-- multi-user, runner-enrollment «Запуск под root»: hello.root of the agent (uid 0 outside a sandbox — Claude Code refuses
-- bypassPermissions). NULL — unknown (an agent without the field). Only adds: an older hub image runs on this schema.
ALTER TABLE runners ADD COLUMN IF NOT EXISTS runs_as_root boolean;
