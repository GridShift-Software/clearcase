CREATE TABLE tags (note_id TEXT NOT NULL REFERENCES notes (id), tag TEXT NOT NULL);
INSERT INTO tags (note_id, tag) VALUES ('seed-1', 'synthetic');
