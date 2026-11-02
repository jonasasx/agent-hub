-- M4a (design D6, D9): the project catalogue, path signals with remote, manual labels, handoff drafts (M4b);
-- credentials removed from stored git remotes (D9 p. 7).
CREATE TABLE projects (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('area', 'system', 'project', 'repo', 'builtin')),
  area_path    text,
  path         text NOT NULL,
  slug         text NOT NULL,
  title        text NOT NULL,
  summary      text NOT NULL DEFAULT '',
  archived     boolean NOT NULL DEFAULT false,
  color_key    text NOT NULL DEFAULT 'none',
  git_remotes  text[] NOT NULL DEFAULT '{}',
  clone_paths  text[] NOT NULL DEFAULT '{}',
  origin       text NOT NULL CHECK (origin IN ('index', 'repos', 'builtin')),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, path)
);
CREATE INDEX projects_git_remotes_idx ON projects USING gin (git_remotes);

UPDATE sessions SET project_id = NULL, secondary_project_id = NULL WHERE project_id IS NOT NULL OR secondary_project_id IS NOT NULL;
ALTER TABLE sessions
  ADD CONSTRAINT sessions_project_fk FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE SET NULL,
  ADD CONSTRAINT sessions_secondary_project_fk FOREIGN KEY (secondary_project_id) REFERENCES projects (id) ON DELETE SET NULL;

DELETE FROM path_touches;
ALTER TABLE path_touches DROP CONSTRAINT path_touches_op_check;
ALTER TABLE path_touches ADD CONSTRAINT path_touches_op_check CHECK (op IN ('edit', 'read', 'cwd', 'remote'));
ALTER TABLE path_touches ADD CONSTRAINT path_touches_project_fk FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE SET NULL;
CREATE UNIQUE INDEX path_touches_line_idx ON path_touches (file_id, line_no, op, path_norm);

CREATE TABLE classification_labels (
  session_id  uuid PRIMARY KEY REFERENCES sessions (id) ON DELETE CASCADE,
  project_id  uuid REFERENCES projects (id) ON DELETE SET NULL,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE handoff_drafts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  session_id   uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  status       text NOT NULL CHECK (status IN ('pending', 'ready', 'error')),
  text         text,
  error        text,
  runner_id    text REFERENCES runners (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
CREATE INDEX handoff_drafts_session_idx ON handoff_drafts (session_id, created_at DESC);

-- https://oauth2:<token>@host/... -> https://host/... (a token of GitLab was stored with 119 sessions of the VM).
-- Everything up to the last @ before the first / after the scheme goes (a password may contain @).
UPDATE sessions SET git_remote = regexp_replace(git_remote, '^([a-zA-Z][a-zA-Z0-9+.-]*://)[^/]*@', '\1')
 WHERE git_remote ~ '^[a-zA-Z][a-zA-Z0-9+.-]*://[^/]*@';

-- Ivan's request in M4a: a session written outside the hub right now is «работает в <источник>», not «завершена».
-- Hub time (D9 p. 10b): when the hub last received an external write, and the start of the current streak.
ALTER TABLE sessions ADD COLUMN external_seen_at timestamptz;
ALTER TABLE sessions ADD COLUMN external_since timestamptz;
