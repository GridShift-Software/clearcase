-- NATIVE24: the verification work ledger. `verifyVersion` runs under a case read grant and reads and hashes package files and
-- originals, so before any R2 read it reserves its planned objects and bytes against its case's current window in one atomic
-- upsert (`verification.ts`). A reservation that would pass the window's bounds changes nothing and the call answers `busy`.
-- Only counts are kept; no verification result is cached across requests. Rows of earlier windows of the case are deleted
-- by the next reservation. Applied by the deployment after 0001, never by the Worker.
CREATE TABLE rs_verification_work (
  case_id TEXT NOT NULL REFERENCES rs_case,
  window_start INTEGER NOT NULL CHECK (window_start >= 0),
  objects INTEGER NOT NULL CHECK (objects >= 0),
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  PRIMARY KEY (case_id, window_start)
);
