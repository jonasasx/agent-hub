DROP INDEX IF EXISTS events_session_uuid_idx;
CREATE INDEX events_uuid_idx ON events (uuid);
