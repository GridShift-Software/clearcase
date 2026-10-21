-- The recovery probe's tables (GRS-110), applied after GRS-109's tests/hosting-probe/storage/schema.sql to the same
-- per-client database. None is named uw_*, so case backups and user-work restores (which cover every uw_* table) leave
-- them alone.

-- A case's deletion, from the firm admin's request to the removal of live access. One row per case, never deleted: once
-- `removed`, it is the D1 copy of the case's deletion record (deletion/<caseId>.json in BUCKET and in RECOVERY), and
-- holds ids, roles and times only, no case content, apart from erase_plan: the results version ids, export ids and the
-- SHA-256 of each original (a fingerprint of a removed document, never its bytes) the removal erased, so a repeated removal
-- or a reapplied record erases the same objects. The deletion record in the buckets carries no erase_plan.
CREATE TABLE case_deletion (
  case_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('requested', 'approved', 'offered', 'removed')),
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  approved_by TEXT,
  approved_at TEXT,
  export_id TEXT,
  export_sha256 TEXT,
  export_size INTEGER,
  offered_at TEXT,
  removed_by TEXT,
  removed_at TEXT,
  erase_plan TEXT
);

-- Bundle history: a stand-in for GRS-128's PDF bundle versions (bundle/<caseId>/<bundleId>.pdf in BUCKET), modelled only
-- so the probe can show that recovery-copy rotation never touches it.
CREATE TABLE bundle_version (case_id TEXT NOT NULL, bundle_id TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (case_id, bundle_id));
