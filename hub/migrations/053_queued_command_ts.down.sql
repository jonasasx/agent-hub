-- The time a queued message was sent is still in its line.
UPDATE events
   SET ts = (payload->>'timestamp')::timestamptz
 WHERE type = 'attachment' AND payload->'attachment'->>'type' = 'queued_command' AND payload->>'timestamp' IS NOT NULL;
