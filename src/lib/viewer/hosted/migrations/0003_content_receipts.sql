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
