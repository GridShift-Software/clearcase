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
  -- finalized: the original is bound to the case and the revision below records it.
  state TEXT NOT NULL CHECK (state IN ('received', 'stored', 'finalized')),
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

-- A finalized revision never changes: no row of it is updated or deleted. A later file is a new revision.
CREATE TRIGGER IF NOT EXISTS submissions_revision_immutable_update BEFORE UPDATE ON submissions_revision BEGIN SELECT RAISE(ABORT, 'submission revision is immutable'); END;
CREATE TRIGGER IF NOT EXISTS submissions_revision_immutable_delete BEFORE DELETE ON submissions_revision BEGIN SELECT RAISE(ABORT, 'submission revision is immutable'); END;
CREATE TRIGGER IF NOT EXISTS submissions_file_immutable_update BEFORE UPDATE ON submissions_file BEGIN SELECT RAISE(ABORT, 'submission file is immutable'); END;
CREATE TRIGGER IF NOT EXISTS submissions_file_immutable_delete BEFORE DELETE ON submissions_file BEGIN SELECT RAISE(ABORT, 'submission file is immutable'); END;
-- A declaration's content never changes; only its state moves forward (received -> stored -> finalized).
CREATE TRIGGER IF NOT EXISTS submissions_upload_declaration_fixed BEFORE UPDATE ON submissions_upload
  WHEN NEW.client_id IS NOT OLD.client_id OR NEW.case_id IS NOT OLD.case_id OR NEW.operation_id IS NOT OLD.operation_id OR NEW.asset_id IS NOT OLD.asset_id
    OR NEW.path IS NOT OLD.path OR NEW.filename IS NOT OLD.filename OR NEW.media_type IS NOT OLD.media_type OR NEW.size IS NOT OLD.size OR NEW.sha256 IS NOT OLD.sha256
    OR NEW.principal_issuer IS NOT OLD.principal_issuer OR NEW.principal_subject IS NOT OLD.principal_subject OR NEW.declared_at IS NOT OLD.declared_at
    OR (OLD.state = 'stored' AND NEW.state = 'received') OR (OLD.state = 'finalized' AND NEW.state <> 'finalized')
  BEGIN SELECT RAISE(ABORT, 'submission upload declaration is fixed'); END;
CREATE TRIGGER IF NOT EXISTS submissions_upload_no_delete BEFORE DELETE ON submissions_upload BEGIN SELECT RAISE(ABORT, 'submission upload is retained'); END;
