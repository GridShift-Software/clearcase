-- ClearCase native evidence increment 0005. Requires applied 0001, 0002 and 0004; 0003 remains reserved.
-- src/lib/publication/hosted/migrations/0004_publication_evidence.sql
-- Additive publication evidence for the native 0005 increment. Generations are independent;
-- item_json is the canonical observation, including its exact input and version bindings.
CREATE TABLE pub_evidence_run (
  candidate_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  client_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  results_version TEXT NOT NULL,
  manifest_sha256 TEXT NOT NULL,
  validator_version TEXT NOT NULL,
  renderer_version TEXT NOT NULL,
  state TEXT NOT NULL,
  cursor TEXT,
  lease_token TEXT,
  lease_until_ms INTEGER,
  evidence_root TEXT,
  PRIMARY KEY (candidate_id, generation)
);
CREATE TABLE pub_evidence_item (
  candidate_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  item_key TEXT NOT NULL,
  item_json TEXT NOT NULL CHECK (json_valid(item_json)),
  PRIMARY KEY (candidate_id, generation, item_key)
);
CREATE TABLE pub_evidence_page (
  candidate_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  page_number INTEGER NOT NULL CHECK (page_number >= 0),
  page_sha256 TEXT NOT NULL CHECK (length(page_sha256) = 64),
  item_count INTEGER NOT NULL CHECK (item_count BETWEEN 1 AND 500),
  PRIMARY KEY (candidate_id, generation, page_number)
);
CREATE TABLE pub_signoff_evidence (
  signoff_id TEXT NOT NULL PRIMARY KEY REFERENCES pub_signoff(signoff_id),
  candidate_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  evidence_root TEXT NOT NULL CHECK (length(evidence_root) = 64)
);
-- BEFORE INSERT guards also refuse INSERT OR REPLACE, regardless of recursive_triggers.
CREATE TRIGGER pub_evidence_item_insert_seal BEFORE INSERT ON pub_evidence_item
WHEN EXISTS (SELECT 1 FROM pub_evidence_item WHERE candidate_id=NEW.candidate_id AND generation=NEW.generation AND item_key=NEW.item_key)
BEGIN SELECT RAISE(ABORT, 'evidence item immutable'); END;
CREATE TRIGGER pub_evidence_item_update_seal BEFORE UPDATE ON pub_evidence_item BEGIN SELECT RAISE(ABORT, 'evidence item immutable'); END;
CREATE TRIGGER pub_evidence_item_delete_seal BEFORE DELETE ON pub_evidence_item BEGIN SELECT RAISE(ABORT, 'evidence item immutable'); END;
CREATE TRIGGER pub_evidence_page_insert_seal BEFORE INSERT ON pub_evidence_page
WHEN EXISTS (SELECT 1 FROM pub_evidence_page WHERE candidate_id=NEW.candidate_id AND generation=NEW.generation AND page_number=NEW.page_number)
BEGIN SELECT RAISE(ABORT, 'evidence page immutable'); END;
CREATE TRIGGER pub_evidence_page_update_seal BEFORE UPDATE ON pub_evidence_page BEGIN SELECT RAISE(ABORT, 'evidence page immutable'); END;
CREATE TRIGGER pub_evidence_page_delete_seal BEFORE DELETE ON pub_evidence_page BEGIN SELECT RAISE(ABORT, 'evidence page immutable'); END;
CREATE TRIGGER pub_signoff_evidence_insert_seal BEFORE INSERT ON pub_signoff_evidence
WHEN EXISTS (SELECT 1 FROM pub_signoff_evidence WHERE signoff_id=NEW.signoff_id)
BEGIN SELECT RAISE(ABORT, 'signoff evidence immutable'); END;
CREATE TRIGGER pub_signoff_evidence_update_seal BEFORE UPDATE ON pub_signoff_evidence BEGIN SELECT RAISE(ABORT, 'signoff evidence immutable'); END;
CREATE TRIGGER pub_signoff_evidence_delete_seal BEFORE DELETE ON pub_signoff_evidence BEGIN SELECT RAISE(ABORT, 'signoff evidence immutable'); END;


-- src/lib/viewer/hosted/migrations/0003_content_receipts.sql
-- Reusable rendering evidence binds bytes, renderer and the exact set of checked pages.
CREATE TABLE npr_content_receipts (
  input_sha256 TEXT NOT NULL CHECK (length(input_sha256) = 64),
  input_size INTEGER NOT NULL CHECK (input_size >= 0),
  renderer_version TEXT NOT NULL,
  page_set TEXT NOT NULL CHECK (json_valid(page_set)),
  page_count INTEGER NOT NULL CHECK (page_count > 0),
  receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
  PRIMARY KEY (input_sha256, input_size, renderer_version, page_set)
);
CREATE TRIGGER npr_content_receipts_insert_seal BEFORE INSERT ON npr_content_receipts
WHEN EXISTS (SELECT 1 FROM npr_content_receipts WHERE input_sha256=NEW.input_sha256 AND input_size=NEW.input_size AND renderer_version=NEW.renderer_version AND page_set=NEW.page_set)
BEGIN SELECT RAISE(ABORT, 'content receipt immutable'); END;
CREATE TRIGGER npr_content_receipts_update_seal BEFORE UPDATE ON npr_content_receipts BEGIN SELECT RAISE(ABORT, 'content receipt immutable'); END;
CREATE TRIGGER npr_content_receipts_delete_seal BEFORE DELETE ON npr_content_receipts BEGIN SELECT RAISE(ABORT, 'content receipt immutable'); END;

