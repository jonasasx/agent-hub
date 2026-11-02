-- projects-catalog: user owned, manually curated projects, separate from the legacy vault-derived `projects` table.
ALTER TABLE runners ADD CONSTRAINT runners_user_id_id_key UNIQUE(user_id, id);
ALTER TABLE sessions ADD CONSTRAINT sessions_user_id_id_key UNIQUE(user_id, id);
CREATE TABLE catalog_projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  remote text,
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_event_at timestamptz,
  UNIQUE(user_id, id)
);
CREATE INDEX catalog_projects_recent_idx ON catalog_projects(user_id, last_event_at DESC NULLS LAST, name);
CREATE TABLE project_bindings (
  user_id uuid NOT NULL,
  project_id uuid NOT NULL,
  runner_id text NOT NULL,
  path text NOT NULL CHECK (length(path) BETWEEN 1 AND 4096),
  PRIMARY KEY(user_id, project_id, runner_id),
  UNIQUE(user_id, runner_id, path),
  FOREIGN KEY(user_id, project_id) REFERENCES catalog_projects(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY(user_id, runner_id) REFERENCES runners(user_id, id) ON DELETE CASCADE
);
CREATE TABLE user_preferences (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_runner_id text,
  last_provider text CHECK (last_provider IN ('claude', 'codex')),
  FOREIGN KEY(user_id, last_runner_id) REFERENCES runners(user_id, id) ON DELETE SET NULL (last_runner_id)
);
CREATE TABLE session_projects (
  user_id uuid NOT NULL,
  session_id uuid NOT NULL,
  project_id uuid NOT NULL,
  source text NOT NULL DEFAULT 'explicit' CHECK (source IN ('explicit', 'auto', 'manual')),
  confidence real CHECK (confidence BETWEEN 0 AND 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id, session_id),
  FOREIGN KEY(user_id, session_id) REFERENCES sessions(user_id, id) ON DELETE CASCADE,
  FOREIGN KEY(user_id, project_id) REFERENCES catalog_projects(user_id, id) ON DELETE CASCADE
);
