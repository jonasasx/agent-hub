-- Review M2: events are looked up by uuid within a session (tool_use/tool_result pairs, parents); a global
-- uuid index is not used by any query. The ON CONFLICT target of events is its primary key, not this index.
DROP INDEX IF EXISTS events_uuid_idx;
CREATE INDEX events_session_uuid_idx ON events (session_id, uuid);
