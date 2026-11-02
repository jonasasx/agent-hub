-- M2: sessions, chat events of hub sessions, permission requests, hub notes, tabs, layouts (design.md D6, D8).
-- Columns used from M3/M4 (project_*, fork_*, search) are created now so later migrations only add indexes
-- and foreign keys; `events` gets search_text/tsv in M3.

CREATE TABLE sessions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                 uuid NOT NULL REFERENCES users (id),
  runner_id               text NOT NULL REFERENCES runners (id),
  claude_session_id       uuid NOT NULL,
  cwd                     text,
  git_branch              text,
  git_remote              text,
  source                  text NOT NULL CHECK (source IN ('hub', 'terminal', 'orca', 'remote_control', 'cron', 'drive_import')),
  is_hub_managed          boolean NOT NULL DEFAULT false,
  title                   text NOT NULL DEFAULT '',
  title_source            text NOT NULL DEFAULT 'none' CHECK (title_source IN ('custom', 'ai', 'prompt', 'none')),
  status                  text NOT NULL CHECK (status IN ('working', 'waiting', 'permission', 'sleeping', 'closed')),
  process_alive           boolean NOT NULL DEFAULT false,
  unread                  boolean NOT NULL DEFAULT false,
  read_only_reason        text CHECK (read_only_reason IN ('cwd_missing', 'cron', 'unknown_runner')),
  project_id              uuid,
  project_source          text NOT NULL DEFAULT 'none' CHECK (project_source IN ('auto', 'manual', 'inherited', 'none')),
  project_evidence        jsonb,
  secondary_project_id    uuid,
  fork_of                 uuid REFERENCES sessions (id) ON DELETE SET NULL,
  fork_mode               text CHECK (fork_mode IN ('copy', 'handoff')),
  permission_mode         text NOT NULL DEFAULT 'bypassPermissions',
  model                   text,
  idle_timeout_min        integer CHECK (idle_timeout_min IS NULL OR idle_timeout_min >= 0),   -- NULL default, 0 never
  last_input_at           timestamptz,
  last_turn_end_at        timestamptz,
  slept_at                timestamptz,
  first_event_at          timestamptz,
  last_event_at           timestamptz,
  last_external_write_at  timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (runner_id, claude_session_id)
);
CREATE INDEX sessions_user_recent_idx ON sessions (user_id, last_event_at DESC);
CREATE INDEX sessions_user_project_idx ON sessions (user_id, project_id, last_event_at DESC);
CREATE INDEX sessions_user_status_idx ON sessions (user_id, status);

CREATE TABLE transcript_files (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id           uuid NOT NULL REFERENCES users (id),
  session_id        uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  rel_path          text NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('main', 'subagent')),
  agent_id          text,
  generation        integer NOT NULL DEFAULT 0,
  acked_line        bigint NOT NULL DEFAULT 0,
  acked_byte        bigint NOT NULL DEFAULT 0,
  size              bigint NOT NULL DEFAULT 0,
  raw_flushed_line  bigint NOT NULL DEFAULT 0,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, rel_path)
);

CREATE TABLE events (
  file_id      bigint NOT NULL REFERENCES transcript_files (id) ON DELETE CASCADE,
  generation   integer NOT NULL,
  line_no      bigint NOT NULL,
  session_id   uuid NOT NULL,
  uuid         text,
  parent_uuid  text,
  type         text NOT NULL,
  subtype      text,
  ts           timestamptz NOT NULL,
  is_sidechain boolean NOT NULL DEFAULT false,
  payload      jsonb COMPRESSION lz4 NOT NULL,
  PRIMARY KEY (file_id, generation, line_no)
);
CREATE INDEX events_session_ts_idx ON events (session_id, ts);
CREATE INDEX events_uuid_idx ON events (uuid);

CREATE TABLE permission_requests (
  request_id   uuid PRIMARY KEY,
  session_id   uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  tool_name    text NOT NULL,
  tool_use_id  text NOT NULL,
  input        jsonb NOT NULL,
  suggestions  jsonb NOT NULL DEFAULT '[]',
  created_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at  timestamptz,
  decision     text CHECK (decision IN ('allow', 'allow_session', 'deny')),
  scope        text CHECK (scope IN ('once', 'session')),
  message      text
);
CREATE INDEX permission_requests_open_idx ON permission_requests (session_id) WHERE resolved_at IS NULL;

-- System marks written by the hub into the chat: resume, interrupt, mode change, crashes (not in .jsonl).
CREATE TABLE session_notes (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id  uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  ts          timestamptz NOT NULL DEFAULT now(),
  kind        text NOT NULL,
  text        text NOT NULL
);
CREATE INDEX session_notes_session_ts_idx ON session_notes (session_id, ts);

CREATE TABLE open_tabs (
  user_id         uuid NOT NULL REFERENCES users (id),
  session_id      uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  opened_at       timestamptz NOT NULL DEFAULT now(),
  last_opened_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, session_id)
);

CREATE TABLE ui_layouts (
  user_id       uuid NOT NULL REFERENCES users (id),
  device_class  text NOT NULL CHECK (device_class IN ('desktop', 'phone')),
  layout        jsonb,
  saved_layout  jsonb,
  version       integer NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, device_class)
);
