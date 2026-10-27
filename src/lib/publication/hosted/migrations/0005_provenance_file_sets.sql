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
