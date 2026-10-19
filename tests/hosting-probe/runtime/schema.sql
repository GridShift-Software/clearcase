-- Applied by the runner through `wrangler d1 execute --local`, a separate process from the Worker: the render leg then
-- proves the CLI and workerd share one local D1 state.
CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT NOT NULL);
INSERT INTO notes (id, body) VALUES ('seed-1', 'synthetic seed note');
