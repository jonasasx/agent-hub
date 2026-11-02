-- M3a: replication of every .jsonl (design D4, D5, D6, D7).

-- Sources (D5): Remote Control becomes a flag, `desktop` is a new source.
ALTER TABLE sessions DROP CONSTRAINT sessions_source_check;
ALTER TABLE sessions ADD COLUMN remote_control boolean NOT NULL DEFAULT false;
UPDATE sessions SET remote_control = true, source = 'terminal' WHERE source = 'remote_control';
ALTER TABLE sessions ADD CONSTRAINT sessions_source_check
  CHECK (source IN ('hub', 'terminal', 'orca', 'desktop', 'cron', 'drive_import'));
-- Signals the source is derived from, accumulated over all lines of the session (D5).
ALTER TABLE sessions
  ADD COLUMN seen_cli boolean NOT NULL DEFAULT false,      -- a line with entrypoint = cli
  ADD COLUMN seen_sdk_cli boolean NOT NULL DEFAULT false,  -- a line with entrypoint = sdk-cli
  ADD COLUMN seen_human boolean NOT NULL DEFAULT false,    -- a user line with turnOrigin/origin.kind = human
  ADD COLUMN cron_marker boolean NOT NULL DEFAULT false;   -- repl.meta.cronMarker from the agent

-- Transcript files exist before their session row (an empty file or one with only service lines creates no
-- session, D5), so a file belongs to the runner; on Windows runners the key is case-insensitive (D4: the same file
-- is seen as C--Users-… and c--Users-…).
ALTER TABLE transcript_files
  ADD COLUMN runner_id text REFERENCES runners (id),
  ADD COLUMN claude_session_id uuid,
  ADD COLUMN rel_key text,
  ADD COLUMN raw_segments integer NOT NULL DEFAULT 0,      -- raw/… segments written since the last merge (D4)
  ADD COLUMN raw_merged_at timestamptz;
UPDATE transcript_files f
   SET runner_id = s.runner_id,
       claude_session_id = s.claude_session_id,
       rel_key = CASE WHEN r.home_dir ~ '^[A-Za-z]:' THEN lower(f.rel_path) ELSE f.rel_path END
  FROM sessions s JOIN runners r ON r.id = s.runner_id
 WHERE s.id = f.session_id;
ALTER TABLE transcript_files
  ALTER COLUMN runner_id SET NOT NULL,
  ALTER COLUMN claude_session_id SET NOT NULL,
  ALTER COLUMN rel_key SET NOT NULL,
  ALTER COLUMN session_id DROP NOT NULL;
ALTER TABLE transcript_files DROP CONSTRAINT transcript_files_session_id_rel_path_key;
CREATE UNIQUE INDEX transcript_files_runner_rel_key_idx ON transcript_files (runner_id, rel_key);
CREATE INDEX transcript_files_session_idx ON transcript_files (session_id);
CREATE INDEX transcript_files_claude_idx ON transcript_files (runner_id, claude_session_id);

-- Full-text search (D6): text blocks of user and assistant messages.
ALTER TABLE events ADD COLUMN search_text text;
UPDATE events e
   SET search_text = t.txt
  FROM (
    SELECT file_id, generation, line_no,
           CASE WHEN jsonb_typeof(payload -> 'message' -> 'content') = 'string' THEN payload -> 'message' ->> 'content'
                ELSE (SELECT string_agg(b ->> 'text', E'\n')
                        FROM jsonb_array_elements(payload -> 'message' -> 'content') b
                       WHERE b ->> 'type' = 'text') END AS txt
      FROM events
     WHERE type IN ('user', 'assistant') AND COALESCE((payload ->> 'isMeta')::boolean, false) = false
  ) t
 WHERE e.file_id = t.file_id AND e.generation = t.generation AND e.line_no = t.line_no;
ALTER TABLE events ADD COLUMN tsv tsvector GENERATED ALWAYS AS (
  to_tsvector('russian', COALESCE(search_text, '')) || to_tsvector('english', COALESCE(search_text, ''))
) STORED;
CREATE INDEX events_tsv_idx ON events USING gin (tsv);

-- Payloads moved out of events (D4, D7): content-addressed objects blobs/<sha256>.
CREATE TABLE blobs (
  sha256      text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  s3_key      text NOT NULL,
  size        bigint NOT NULL,
  mime        text NOT NULL,
  width       integer,
  height      integer,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Images uploaded by the user for sending (D19, M3b).
CREATE TABLE uploads (
  sha256      text NOT NULL REFERENCES blobs (sha256),
  user_id     uuid NOT NULL REFERENCES users (id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  used_at     timestamptz,
  PRIMARY KEY (user_id, sha256)
);
CREATE INDEX uploads_created_at_idx ON uploads (created_at);

-- Path signals for project classification (D9, M4).
CREATE TABLE path_touches (
  session_id  uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  file_id     bigint NOT NULL REFERENCES transcript_files (id) ON DELETE CASCADE,
  line_no     bigint NOT NULL,
  op          text NOT NULL CHECK (op IN ('edit', 'read', 'cwd')),
  path_norm   text NOT NULL,
  project_id  uuid
);
CREATE INDEX path_touches_session_idx ON path_touches (session_id);
CREATE INDEX path_touches_path_idx ON path_touches (path_norm);
