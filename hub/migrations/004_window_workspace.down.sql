-- Back to the schema of 002: open_tabs (empty) and ui_layouts.version (0).
ALTER TABLE ui_layouts DROP COLUMN opened_at;
ALTER TABLE ui_layouts ADD COLUMN version integer NOT NULL DEFAULT 0;
CREATE TABLE open_tabs (
  user_id         uuid NOT NULL REFERENCES users (id),
  session_id      uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  opened_at       timestamptz NOT NULL DEFAULT now(),
  last_opened_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, session_id)
);
