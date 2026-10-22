-- Synthetic schema for the deployment probe (GRS-107).
CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT NOT NULL);
INSERT INTO notes (id, body) VALUES ('seed-1', 'synthetic seed note');
