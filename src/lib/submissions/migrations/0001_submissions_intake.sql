-- GRS-137 hosted client intake: one client's per-deployment D1, namespace submissions_*. Unreleased; never applied to any D1.
-- An upload is one operation that supplies one file; a finalized upload becomes one immutable submission revision.
CREATE TABLE IF NOT EXISTS submissions_upload (
  client_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  path TEXT NOT NULL,
  filename TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type = 'application/pdf'),
  size INTEGER NOT NULL CHECK (size > 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  -- received: declared, no bytes acknowledged; stored: the original store acknowledged this operation's verified bytes;
  -- reserved: the revision below (its sequence, path, size and sha256) is durably recorded and the original may now be
  -- finalized, but the submission is not shown as final; finalized: the original is bound to the case and the revision is final.
  state TEXT NOT NULL CHECK (state IN ('received', 'stored', 'reserved', 'finalized')),
  principal_issuer TEXT NOT NULL,
  principal_subject TEXT NOT NULL,
  declared_at TEXT NOT NULL,
  stored_at TEXT,
  PRIMARY KEY (client_id, case_id, operation_id),
  UNIQUE (client_id, case_id, asset_id)
);

CREATE TABLE IF NOT EXISTS submissions_revision (
  client_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  operation_id TEXT NOT NULL,
  file_count INTEGER NOT NULL CHECK (file_count = 1),
  finalized_at TEXT NOT NULL,
  PRIMARY KEY (client_id, case_id, revision_id),
  UNIQUE (client_id, case_id, sequence),
  UNIQUE (client_id, case_id, operation_id),
  FOREIGN KEY (client_id, case_id, operation_id) REFERENCES submissions_upload (client_id, case_id, operation_id)
);

CREATE TABLE IF NOT EXISTS submissions_file (
  client_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  path TEXT NOT NULL,
  -- the collision key: two paths that differ only by case are one path within a revision
  path_key TEXT NOT NULL,
  filename TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  PRIMARY KEY (client_id, case_id, revision_id, path_key),
  FOREIGN KEY (client_id, case_id, revision_id) REFERENCES submissions_revision (client_id, case_id, revision_id)
);

-- Immutability. UPDATE and DELETE are refused by the triggers below. INSERT OR REPLACE and REPLACE conflict handling delete the
-- conflicting row without firing DELETE triggers (SQLite's recursive_triggers is off by default, and D1 is not asked to turn it
-- on), so BEFORE INSERT triggers refuse every insert that collides with an existing row on ANY unique key: primary key, the
-- (case, sequence), (case, operation) and (case, asset) keys, and the one file of a revision. BEFORE triggers run before the
-- conflict clause is applied, so no OR REPLACE / OR IGNORE form reaches an existing row. The request path never uses REPLACE;
-- this guards against an accidental statement or a later change, not against an administrator who drops the schema.
CREATE TRIGGER IF NOT EXISTS submissions_upload_insert_once BEFORE INSERT ON submissions_upload
  WHEN NEW.state <> 'received'
    OR EXISTS (SELECT 1 FROM submissions_upload WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND (operation_id = NEW.operation_id OR asset_id = NEW.asset_id))
  BEGIN SELECT RAISE(ABORT, 'submission upload is declared once, as received'); END;
CREATE TRIGGER IF NOT EXISTS submissions_revision_insert_once BEFORE INSERT ON submissions_revision
  WHEN EXISTS (SELECT 1 FROM submissions_revision WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND (revision_id = NEW.revision_id OR sequence = NEW.sequence OR operation_id = NEW.operation_id))
    OR NEW.sequence <> (SELECT COALESCE(MAX(sequence), 0) + 1 FROM submissions_revision WHERE client_id = NEW.client_id AND case_id = NEW.case_id)
    OR NOT EXISTS (SELECT 1 FROM submissions_upload WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND operation_id = NEW.operation_id AND state IN ('stored', 'reserved', 'finalized'))
  BEGIN SELECT RAISE(ABORT, 'submission revision is immutable: one per operation, the next sequence, from a stored upload'); END;
CREATE TRIGGER IF NOT EXISTS submissions_file_insert_once BEFORE INSERT ON submissions_file
  WHEN EXISTS (SELECT 1 FROM submissions_file WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND revision_id = NEW.revision_id)
  BEGIN SELECT RAISE(ABORT, 'submission file is immutable: a revision has its one file'); END;
CREATE TRIGGER IF NOT EXISTS submissions_file_matches_declaration BEFORE INSERT ON submissions_file
  WHEN NOT EXISTS (
    SELECT 1 FROM submissions_revision r JOIN submissions_upload u ON u.client_id = r.client_id AND u.case_id = r.case_id AND u.operation_id = r.operation_id
    WHERE r.client_id = NEW.client_id AND r.case_id = NEW.case_id AND r.revision_id = NEW.revision_id
      AND u.path = NEW.path AND u.filename = NEW.filename AND u.media_type = NEW.media_type AND u.size = NEW.size AND u.sha256 = NEW.sha256 AND u.asset_id = NEW.asset_id)
  BEGIN SELECT RAISE(ABORT, 'submission file must match its declaration'); END;

-- A finalized revision never changes: no row of it is updated or deleted. A later file is a new revision.
CREATE TRIGGER IF NOT EXISTS submissions_revision_immutable_update BEFORE UPDATE ON submissions_revision BEGIN SELECT RAISE(ABORT, 'submission revision is immutable'); END;
CREATE TRIGGER IF NOT EXISTS submissions_revision_immutable_delete BEFORE DELETE ON submissions_revision BEGIN SELECT RAISE(ABORT, 'submission revision is immutable'); END;
CREATE TRIGGER IF NOT EXISTS submissions_file_immutable_update BEFORE UPDATE ON submissions_file BEGIN SELECT RAISE(ABORT, 'submission file is immutable'); END;
CREATE TRIGGER IF NOT EXISTS submissions_file_immutable_delete BEFORE DELETE ON submissions_file BEGIN SELECT RAISE(ABORT, 'submission file is immutable'); END;
-- A declaration's content never changes; only its state moves forward (received -> stored -> reserved -> finalized; stored -> finalized
-- is the one-step form of the last two). It never skips `stored`, and never moves back.
CREATE TRIGGER IF NOT EXISTS submissions_upload_declaration_fixed BEFORE UPDATE ON submissions_upload
  WHEN NEW.client_id IS NOT OLD.client_id OR NEW.case_id IS NOT OLD.case_id OR NEW.operation_id IS NOT OLD.operation_id OR NEW.asset_id IS NOT OLD.asset_id
    OR NEW.path IS NOT OLD.path OR NEW.filename IS NOT OLD.filename OR NEW.media_type IS NOT OLD.media_type OR NEW.size IS NOT OLD.size OR NEW.sha256 IS NOT OLD.sha256
    OR NEW.principal_issuer IS NOT OLD.principal_issuer OR NEW.principal_subject IS NOT OLD.principal_subject OR NEW.declared_at IS NOT OLD.declared_at
    OR (OLD.state = 'received' AND NEW.state NOT IN ('received', 'stored'))
    OR (OLD.state = 'stored' AND NEW.state = 'received') OR (OLD.state = 'reserved' AND NEW.state IN ('received', 'stored')) OR (OLD.state = 'finalized' AND NEW.state <> 'finalized')
  BEGIN SELECT RAISE(ABORT, 'submission upload declaration is fixed'); END;
-- An upload is reserved or finalized only once its revision is durably recorded: no original is made visible without it.
CREATE TRIGGER IF NOT EXISTS submissions_upload_needs_revision BEFORE UPDATE ON submissions_upload
  WHEN NEW.state IN ('reserved', 'finalized') AND OLD.state <> NEW.state
    AND NOT EXISTS (SELECT 1 FROM submissions_file f JOIN submissions_revision r ON r.client_id = f.client_id AND r.case_id = f.case_id AND r.revision_id = f.revision_id
      WHERE r.client_id = NEW.client_id AND r.case_id = NEW.case_id AND r.operation_id = NEW.operation_id)
  BEGIN SELECT RAISE(ABORT, 'a reserved upload needs its recorded revision'); END;
CREATE TRIGGER IF NOT EXISTS submissions_upload_no_delete BEFORE DELETE ON submissions_upload BEGIN SELECT RAISE(ABORT, 'submission upload is retained'); END;
