-- Second review of M3c: a Drive import whose live copy turned out to be another file is kept, not merged: its
-- transcript row is marked superseded and its events are hidden from the chat, the search and the source signals.
ALTER TABLE transcript_files ADD COLUMN superseded_at timestamptz;
