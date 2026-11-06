CREATE TABLE project_suggestions (
  user_id uuid NOT NULL,
  session_id uuid NOT NULL,
  project_id uuid,
  -- up to 3 candidate projects for the card, best first; ids outside the active catalog are dropped on read
  options uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(options) <= 3),
  new_project_name text CHECK (length(new_project_name) <= 120),
  confidence real NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  reason_code text NOT NULL CHECK (length(reason_code) <= 80),
  input_hash text NOT NULL,
  messages_hash text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','dismissed','accepted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,session_id),
  FOREIGN KEY(user_id,session_id) REFERENCES sessions(user_id,id) ON DELETE CASCADE,
  FOREIGN KEY(user_id,project_id) REFERENCES catalog_projects(user_id,id) ON DELETE CASCADE
);
-- One row per classifier call: limits per session and per day survive restarts and concurrent hub processes.
CREATE TABLE project_classifier_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  session_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(user_id,session_id) REFERENCES sessions(user_id,id) ON DELETE CASCADE
);
CREATE INDEX project_classifier_usage_user_day ON project_classifier_usage(user_id,created_at);
ALTER TABLE session_projects ADD COLUMN reason_code text;
