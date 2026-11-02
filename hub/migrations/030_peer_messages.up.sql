-- change `session-peers` (design D6): the journal of messages between sessions; the rate limits count over it.
CREATE TABLE peer_messages (
  id              uuid PRIMARY KEY,
  user_id         uuid NOT NULL REFERENCES users (id),
  from_session_id uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  to_session_id   uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  text            text NOT NULL,
  in_reply_to     uuid,
  result          text NOT NULL CHECK (result IN ('delivered', 'queued', 'resumed', 'rate_limited', 'error')),
  error_code      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX peer_messages_from_idx ON peer_messages (from_session_id, created_at DESC);
CREATE INDEX peer_messages_to_idx ON peer_messages (to_session_id, created_at DESC);
