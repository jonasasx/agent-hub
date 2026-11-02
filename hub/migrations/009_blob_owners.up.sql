-- M3b (D19): who may read a blob through GET /api/blobs/:sha256. A blob is the user's when it came from one of the
-- user's sessions (replication), uploads or «Показать изображение». Blobs stored before this migration belong to the
-- single user of the hub (personal hub, D12); with several users they would stay unreadable until re-referenced.
CREATE TABLE blob_owners (
  sha256   text NOT NULL REFERENCES blobs (sha256),
  user_id  uuid NOT NULL REFERENCES users (id),
  PRIMARY KEY (sha256, user_id)
);
INSERT INTO blob_owners (sha256, user_id)
SELECT b.sha256, u.id FROM blobs b CROSS JOIN users u WHERE (SELECT count(*) FROM users) = 1
ON CONFLICT DO NOTHING;
