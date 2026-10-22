-- Applied by the runner through `wrangler d1 execute --local` before the server starts. Synthetic: client A's
-- instance, plus one client B case and user in the same store, so a crossed request has something to reach for.
CREATE TABLE users (client TEXT NOT NULL, id TEXT NOT NULL, role TEXT NOT NULL, email TEXT, PRIMARY KEY (client, id));
CREATE TABLE cases (client TEXT NOT NULL, id TEXT NOT NULL, ref TEXT NOT NULL, title TEXT NOT NULL, uploader TEXT NOT NULL, PRIMARY KEY (client, id));
CREATE TABLE documents (client TEXT NOT NULL, case_id TEXT NOT NULL, title TEXT NOT NULL, filename TEXT NOT NULL, PRIMARY KEY (client, case_id, filename));
CREATE TABLE publications (client TEXT NOT NULL, case_id TEXT NOT NULL, version INTEGER NOT NULL, file_key TEXT NOT NULL, file_sha256 TEXT NOT NULL, published_at TEXT NOT NULL, PRIMARY KEY (client, case_id, version));
-- The in-app notice is authoritative; one per event, which keeps the app's own outbox free of duplicates.
CREATE TABLE notices (id TEXT PRIMARY KEY, client TEXT NOT NULL, case_id TEXT NOT NULL, kind TEXT NOT NULL, round INTEGER NOT NULL, recipient TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (client, case_id, kind, round));
CREATE TABLE outbox (notice_id TEXT PRIMARY KEY REFERENCES notices (id), state TEXT NOT NULL, attempts INTEGER NOT NULL, next_at INTEGER, claimed_at INTEGER, updated_at INTEGER NOT NULL);
CREATE TABLE attempts (notice_id TEXT NOT NULL REFERENCES outbox (notice_id), n INTEGER NOT NULL, at INTEGER NOT NULL, outcome TEXT NOT NULL, code TEXT, message_id TEXT, PRIMARY KEY (notice_id, n));

INSERT INTO users (client, id, role, email) VALUES
  ('client-a', 'a-uploader', 'uploader', 'uploader-a@client-a.example.test'),
  ('client-a', 'a-noemail', 'uploader', NULL),
  ('client-a', 'a-viewer', 'viewer', 'viewer-a@client-a.example.test'),
  ('client-a', 'a-publisher', 'publisher', 'publisher-a@client-a.example.test'),
  ('client-a', 'a-operator', 'operator', 'operator-a@client-a.example.test'),
  ('client-b', 'b-uploader', 'uploader', 'uploader-b@client-b.example.test'),
  ('client-b', 'b-publisher', 'publisher', 'publisher-b@client-b.example.test');

INSERT INTO cases (client, id, ref, title, uploader) VALUES
  ('client-a', 'case-a1', 'SYN-A1-0001', 'Synthetic Matter A1', 'a-uploader'),
  ('client-a', 'case-a2', 'SYN-A2-0002', 'Synthetic Matter A2', 'a-uploader'),
  ('client-a', 'case-a3', 'SYN-A3-0003', 'Synthetic Matter A3', 'a-uploader'),
  ('client-a', 'case-a4', 'SYN-A4-0004', 'Synthetic Matter A4', 'a-uploader'),
  ('client-a', 'case-a5', 'SYN-A5-0005', 'Synthetic Matter A5', 'a-noemail'),
  ('client-a', 'case-a6', 'SYN-A6-0006', 'New results', 'a-uploader'),
  ('client-a', 'case-a7', 'SYN-A7-0007', 'Synthetic Matter A7', 'a-uploader'),
  ('client-a', 'case-a8', 'SYN-A8-0008', 'Synthetic Matter A8', 'a-uploader'),
  ('client-a', 'case-a9', 'SYN-A9-0009', 'Synthetic Matter A9', 'a-uploader'),
  ('client-b', 'case-b1', 'SYN-B1-0001', 'Synthetic Matter B1', 'b-uploader');

INSERT INTO documents (client, case_id, title, filename) VALUES
  ('client-a', 'case-a1', 'Synthetic Expert Report', 'a1-report.pdf'),
  ('client-a', 'case-a3', 'Synthetic Witness Statement', 'a3-statement.pdf'),
  ('client-b', 'case-b1', 'Synthetic Pleading B1', 'b1-pleading.pdf');
