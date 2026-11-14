-- Bug 2026-11-14: a message sent mid-turn (`queued_command` attachment) keeps the time it was sent but stands in the
-- file after the lines of the turn that came meanwhile. History pages go by time, so such a line takes the time of the
-- stored line before it (not a queued one) when that is later; ingest does the same for new lines.
UPDATE events e
   SET ts = prev.ts
  FROM (
    SELECT q.file_id, q.generation, q.line_no,
           (SELECT p.ts
              FROM events p
             WHERE p.file_id = q.file_id AND p.generation = q.generation AND p.line_no < q.line_no
               AND NOT (p.type = 'attachment' AND p.payload->'attachment'->>'type' = 'queued_command')
             ORDER BY p.line_no DESC
             LIMIT 1) AS ts
      FROM events q
     WHERE q.type = 'attachment' AND q.payload->'attachment'->>'type' = 'queued_command'
  ) prev
 WHERE e.file_id = prev.file_id AND e.generation = prev.generation AND e.line_no = prev.line_no AND prev.ts > e.ts;
