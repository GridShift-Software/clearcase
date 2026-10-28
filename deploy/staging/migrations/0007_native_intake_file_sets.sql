-- ClearCase native multi-file intake increment 0007. Requires applied 0001, 0002, 0004, 0005 and 0006; 0003 remains reserved.
-- Rebuilds submissions_revision by copy-back under deferred foreign keys; one transaction, never replayed.
-- src/lib/submissions/migrations/0002_submissions_file_sets.sql
-- U16 multi-file intake: one submission revision may hold an immutable set of files. Applied once, after 0001; never in a request.
-- A set is opened with its file count and total bytes. Each file is its own upload (declared, stored, later finalized) and a
-- member of the set. The seal fixes the digest of the file list, records one revision whose operation id is the set id and its
-- files, then finalizes each original in bounded steps; the set is sealed once every original is final.
--
-- submissions_revision is rebuilt to lift its one-file CHECK and its operation-to-upload foreign key (a set's revision names the
-- set). The rows go to a side table and come back under the same name: renaming a new table into place fails, because other
-- tables' trigger bodies name this one. Foreign keys are deferred for the file (submissions_file references the revisions), and
-- the deferral is never switched off here: setting it off resets the violation count, so an orphan would commit.
PRAGMA defer_foreign_keys = on;

CREATE TABLE submissions_set (
  client_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  set_id TEXT NOT NULL,
  file_count INTEGER NOT NULL CHECK (file_count BETWEEN 1 AND 8192),
  total_bytes INTEGER NOT NULL CHECK (total_bytes >= file_count),
  -- open: files are declared and stored; sealing: the digest is fixed, the revision and its files are recorded and the originals
  -- are being finalized, so the set is not final; sealed: every original is final and so is the revision.
  state TEXT NOT NULL CHECK (state IN ('open', 'sealing', 'sealed')),
  files_sha256 TEXT CHECK (files_sha256 IS NULL OR length(files_sha256) = 64),
  principal_issuer TEXT NOT NULL,
  principal_subject TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  sealed_at TEXT,
  PRIMARY KEY (client_id, case_id, set_id),
  CHECK ((state = 'open') = (files_sha256 IS NULL)),
  CHECK ((state = 'sealed') = (sealed_at IS NOT NULL))
);

CREATE TABLE submissions_set_member (
  client_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  set_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  -- the collision key of the file's path: two paths that differ only by case are one path within a set
  path_key TEXT NOT NULL,
  PRIMARY KEY (client_id, case_id, set_id, path_key),
  UNIQUE (client_id, case_id, operation_id),
  FOREIGN KEY (client_id, case_id, set_id) REFERENCES submissions_set (client_id, case_id, set_id),
  FOREIGN KEY (client_id, case_id, operation_id) REFERENCES submissions_upload (client_id, case_id, operation_id)
);

CREATE TABLE submissions_revision_copy AS SELECT client_id, case_id, revision_id, sequence, operation_id, file_count, finalized_at FROM submissions_revision;
DROP TABLE submissions_revision;
CREATE TABLE submissions_revision (
  client_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  -- a one-file revision's upload operation, or a set's id; the insert trigger below checks which
  operation_id TEXT NOT NULL,
  file_count INTEGER NOT NULL CHECK (file_count BETWEEN 1 AND 8192),
  finalized_at TEXT NOT NULL,
  PRIMARY KEY (client_id, case_id, revision_id),
  UNIQUE (client_id, case_id, sequence),
  UNIQUE (client_id, case_id, operation_id)
);
INSERT INTO submissions_revision (client_id, case_id, revision_id, sequence, operation_id, file_count, finalized_at)
  SELECT client_id, case_id, revision_id, sequence, operation_id, file_count, finalized_at FROM submissions_revision_copy;
DROP TABLE submissions_revision_copy;

-- The rebuilt table's own triggers. Update and delete are refused exactly as 0001 wrote them.
CREATE TRIGGER submissions_revision_insert_once BEFORE INSERT ON submissions_revision
  WHEN EXISTS (SELECT 1 FROM submissions_revision WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND (revision_id = NEW.revision_id OR sequence = NEW.sequence OR operation_id = NEW.operation_id))
    OR NEW.sequence <> (SELECT COALESCE(MAX(sequence), 0) + 1 FROM submissions_revision WHERE client_id = NEW.client_id AND case_id = NEW.case_id)
    OR NOT (
      (NEW.file_count = 1
        AND EXISTS (SELECT 1 FROM submissions_upload WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND operation_id = NEW.operation_id AND state IN ('stored', 'reserved', 'finalized'))
        AND NOT EXISTS (SELECT 1 FROM submissions_set_member WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND operation_id = NEW.operation_id))
      OR EXISTS (SELECT 1 FROM submissions_set WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND set_id = NEW.operation_id AND state = 'sealing' AND file_count = NEW.file_count))
  BEGIN SELECT RAISE(ABORT, 'submission revision is immutable: one per operation or set, the next sequence, from a stored upload or a sealing set'); END;
CREATE TRIGGER IF NOT EXISTS submissions_revision_immutable_update BEFORE UPDATE ON submissions_revision BEGIN SELECT RAISE(ABORT, 'submission revision is immutable'); END;
CREATE TRIGGER IF NOT EXISTS submissions_revision_immutable_delete BEFORE DELETE ON submissions_revision BEGIN SELECT RAISE(ABORT, 'submission revision is immutable'); END;

-- A one-file revision holds its one file; a set's revision holds one file per path key of its members. Both refuse a colliding
-- insert before any conflict clause runs, as in 0001.
DROP TRIGGER submissions_file_insert_once;
CREATE TRIGGER submissions_file_insert_once BEFORE INSERT ON submissions_file
  WHEN EXISTS (SELECT 1 FROM submissions_file WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND revision_id = NEW.revision_id AND path_key = NEW.path_key)
    OR (EXISTS (SELECT 1 FROM submissions_file WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND revision_id = NEW.revision_id)
      AND (SELECT file_count FROM submissions_revision WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND revision_id = NEW.revision_id) = 1)
  BEGIN SELECT RAISE(ABORT, 'submission file is immutable: a revision has its one file, or one file per path of its set'); END;
DROP TRIGGER submissions_file_matches_declaration;
CREATE TRIGGER submissions_file_matches_declaration BEFORE INSERT ON submissions_file
  WHEN NOT EXISTS (
    SELECT 1 FROM submissions_revision r JOIN submissions_upload u ON u.client_id = r.client_id AND u.case_id = r.case_id AND u.operation_id = r.operation_id
    WHERE r.client_id = NEW.client_id AND r.case_id = NEW.case_id AND r.revision_id = NEW.revision_id
      AND u.path = NEW.path AND u.filename = NEW.filename AND u.media_type = NEW.media_type AND u.size = NEW.size AND u.sha256 = NEW.sha256 AND u.asset_id = NEW.asset_id)
  AND NOT EXISTS (
    SELECT 1 FROM submissions_revision r
      JOIN submissions_set_member m ON m.client_id = r.client_id AND m.case_id = r.case_id AND m.set_id = r.operation_id
      JOIN submissions_upload u ON u.client_id = m.client_id AND u.case_id = m.case_id AND u.operation_id = m.operation_id
    WHERE r.client_id = NEW.client_id AND r.case_id = NEW.case_id AND r.revision_id = NEW.revision_id AND m.path_key = NEW.path_key
      AND u.path = NEW.path AND u.filename = NEW.filename AND u.media_type = NEW.media_type AND u.size = NEW.size AND u.sha256 = NEW.sha256 AND u.asset_id = NEW.asset_id)
  BEGIN SELECT RAISE(ABORT, 'submission file must match its declaration'); END;

-- An upload is reserved or finalized only once a revision records its file: its own one-file revision, or its set's revision
-- once the set is sealing. No original is made visible without it.
DROP TRIGGER submissions_upload_needs_revision;
CREATE TRIGGER submissions_upload_needs_revision BEFORE UPDATE ON submissions_upload
  WHEN NEW.state IN ('reserved', 'finalized') AND OLD.state <> NEW.state
    AND NOT EXISTS (SELECT 1 FROM submissions_file f JOIN submissions_revision r ON r.client_id = f.client_id AND r.case_id = f.case_id AND r.revision_id = f.revision_id
      WHERE r.client_id = NEW.client_id AND r.case_id = NEW.case_id AND r.operation_id = NEW.operation_id)
    AND NOT EXISTS (SELECT 1 FROM submissions_set_member m
      JOIN submissions_set s ON s.client_id = m.client_id AND s.case_id = m.case_id AND s.set_id = m.set_id AND s.state IN ('sealing', 'sealed')
      JOIN submissions_revision r ON r.client_id = s.client_id AND r.case_id = s.case_id AND r.operation_id = s.set_id
      JOIN submissions_file f ON f.client_id = r.client_id AND f.case_id = r.case_id AND f.revision_id = r.revision_id AND f.path_key = m.path_key AND f.asset_id = NEW.asset_id
      WHERE m.client_id = NEW.client_id AND m.case_id = NEW.case_id AND m.operation_id = NEW.operation_id)
  BEGIN SELECT RAISE(ABORT, 'a reserved upload needs its recorded revision'); END;
-- Set ids and upload ids are one namespace within a case: a revision is found by either.
CREATE TRIGGER submissions_upload_not_a_set BEFORE INSERT ON submissions_upload
  WHEN EXISTS (SELECT 1 FROM submissions_set WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND set_id = NEW.operation_id)
  BEGIN SELECT RAISE(ABORT, 'an upload id is not a set id'); END;

CREATE TRIGGER submissions_set_insert_once BEFORE INSERT ON submissions_set
  WHEN NEW.state <> 'open'
    OR EXISTS (SELECT 1 FROM submissions_set WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND set_id = NEW.set_id)
    OR EXISTS (SELECT 1 FROM submissions_upload WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND operation_id = NEW.set_id)
    OR EXISTS (SELECT 1 FROM submissions_revision WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND operation_id = NEW.set_id)
  BEGIN SELECT RAISE(ABORT, 'a submission set is opened once, as open, under an id no upload uses'); END;
-- A set's declaration never changes, and its state only moves forward. A sealed set never changes at all.
CREATE TRIGGER submissions_set_forward BEFORE UPDATE ON submissions_set
  WHEN OLD.state = 'sealed'
    OR NEW.client_id IS NOT OLD.client_id OR NEW.case_id IS NOT OLD.case_id OR NEW.set_id IS NOT OLD.set_id OR NEW.file_count IS NOT OLD.file_count OR NEW.total_bytes IS NOT OLD.total_bytes
    OR NEW.principal_issuer IS NOT OLD.principal_issuer OR NEW.principal_subject IS NOT OLD.principal_subject OR NEW.opened_at IS NOT OLD.opened_at
    OR (OLD.state = 'open' AND NEW.state NOT IN ('open', 'sealing'))
    OR (OLD.state = 'sealing' AND (NEW.state NOT IN ('sealing', 'sealed') OR NEW.files_sha256 IS NOT OLD.files_sha256))
  BEGIN SELECT RAISE(ABORT, 'a submission set only moves forward: open, sealing, sealed'); END;
-- The seal starts only with exactly the declared files, each stored, holding exactly the declared bytes.
CREATE TRIGGER submissions_set_seal_complete BEFORE UPDATE ON submissions_set
  WHEN OLD.state = 'open' AND NEW.state = 'sealing' AND (
    (SELECT COUNT(*) FROM submissions_set_member WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND set_id = NEW.set_id) <> NEW.file_count
    OR (SELECT COALESCE(SUM(u.size), 0) FROM submissions_set_member m JOIN submissions_upload u ON u.client_id = m.client_id AND u.case_id = m.case_id AND u.operation_id = m.operation_id
      WHERE m.client_id = NEW.client_id AND m.case_id = NEW.case_id AND m.set_id = NEW.set_id) <> NEW.total_bytes
    OR EXISTS (SELECT 1 FROM submissions_set_member m JOIN submissions_upload u ON u.client_id = m.client_id AND u.case_id = m.case_id AND u.operation_id = m.operation_id
      WHERE m.client_id = NEW.client_id AND m.case_id = NEW.case_id AND m.set_id = NEW.set_id AND u.state <> 'stored'))
  BEGIN SELECT RAISE(ABORT, 'a submission set is sealed only with every declared file stored'); END;
-- The set is final only when its revision holds every file and every file's original is final.
CREATE TRIGGER submissions_set_sealed_final BEFORE UPDATE ON submissions_set
  WHEN OLD.state = 'sealing' AND NEW.state = 'sealed' AND (
    NOT EXISTS (SELECT 1 FROM submissions_revision WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND operation_id = NEW.set_id AND file_count = NEW.file_count)
    OR (SELECT COUNT(*) FROM submissions_file f JOIN submissions_revision r ON r.client_id = f.client_id AND r.case_id = f.case_id AND r.revision_id = f.revision_id
      WHERE r.client_id = NEW.client_id AND r.case_id = NEW.case_id AND r.operation_id = NEW.set_id) <> NEW.file_count
    OR EXISTS (SELECT 1 FROM submissions_set_member m JOIN submissions_upload u ON u.client_id = m.client_id AND u.case_id = m.case_id AND u.operation_id = m.operation_id
      WHERE m.client_id = NEW.client_id AND m.case_id = NEW.case_id AND m.set_id = NEW.set_id AND u.state <> 'finalized'))
  BEGIN SELECT RAISE(ABORT, 'a submission set is sealed only once its revision holds every file and every original is final'); END;
CREATE TRIGGER submissions_set_no_delete BEFORE DELETE ON submissions_set BEGIN SELECT RAISE(ABORT, 'submission set is retained'); END;

-- A file joins an open set with room, from its fresh declaration, once; it never leaves and never moves.
CREATE TRIGGER submissions_set_member_insert_once BEFORE INSERT ON submissions_set_member
  WHEN EXISTS (SELECT 1 FROM submissions_set_member WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND ((set_id = NEW.set_id AND path_key = NEW.path_key) OR operation_id = NEW.operation_id))
    OR NOT EXISTS (SELECT 1 FROM submissions_set WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND set_id = NEW.set_id AND state = 'open'
      AND file_count > (SELECT COUNT(*) FROM submissions_set_member WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND set_id = NEW.set_id))
    OR NOT EXISTS (SELECT 1 FROM submissions_upload WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND operation_id = NEW.operation_id AND state = 'received')
    OR EXISTS (SELECT 1 FROM submissions_revision WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND operation_id = NEW.operation_id)
  BEGIN SELECT RAISE(ABORT, 'a set file is added once, to an open set with room, from a fresh declaration'); END;
CREATE TRIGGER submissions_set_member_immutable_update BEFORE UPDATE ON submissions_set_member BEGIN SELECT RAISE(ABORT, 'submission set member is immutable'); END;
CREATE TRIGGER submissions_set_member_immutable_delete BEFORE DELETE ON submissions_set_member BEGIN SELECT RAISE(ABORT, 'submission set member is immutable'); END;


-- src/lib/publication/hosted/migrations/0005_provenance_file_sets.sql
-- U16 publication provenance for multi-file intake, applied with submissions 0002 in one increment, after it.
-- Rebuilding submissions_revision dropped the 0003 fence on its inserts with the old table; it is recreated byte for byte.
-- Opening a set, adding a file to it and moving it to sealing or sealed change folder membership, so they advance the
-- generation like every other dependency write. Apply once during provisioning, NEVER in a request.
CREATE TRIGGER pub_provenance_submissions_revision_insert AFTER INSERT ON submissions_revision
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1 WHERE case_id = NEW.case_id; END;
CREATE TRIGGER pub_provenance_submissions_set_insert AFTER INSERT ON submissions_set
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1 WHERE case_id = NEW.case_id; END;
CREATE TRIGGER pub_provenance_submissions_set_update AFTER UPDATE ON submissions_set
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1 WHERE case_id IN (OLD.case_id, NEW.case_id); END;
CREATE TRIGGER pub_provenance_submissions_set_member_insert AFTER INSERT ON submissions_set_member
  BEGIN UPDATE pub_candidate_generation SET generation = generation + 1 WHERE case_id = NEW.case_id; END;

