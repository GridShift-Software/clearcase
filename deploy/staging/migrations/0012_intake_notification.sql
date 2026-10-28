-- A sealed submission and its notification become durable together. The trigger is
-- part of the seal's transaction; retries cannot create a second notification.
CREATE TABLE sub_notification (
  client_id TEXT NOT NULL,
  case_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  attempted_at TEXT,
  delivered_at TEXT,
  PRIMARY KEY (client_id, case_id, submission_id),
  FOREIGN KEY (client_id, case_id, submission_id)
    REFERENCES submissions_revision (client_id, case_id, operation_id)
);

CREATE TRIGGER sub_notification_on_seal
AFTER UPDATE OF state ON submissions_set
WHEN NEW.state = 'sealed' AND OLD.state = 'sealing'
BEGIN
  INSERT INTO sub_notification (client_id, case_id, submission_id, created_at)
  VALUES (NEW.client_id, NEW.case_id, NEW.set_id, NEW.sealed_at);
END;

-- A one-file submission uses the upload's finalized transition. Set members are
-- excluded: their single notification belongs to the set's later seal.
CREATE TRIGGER sub_notification_on_single_finalized
AFTER UPDATE OF state ON submissions_upload
WHEN NEW.state = 'finalized' AND OLD.state <> 'finalized'
  AND NOT EXISTS (
    SELECT 1 FROM submissions_set_member m
    WHERE m.client_id = NEW.client_id AND m.case_id = NEW.case_id AND m.operation_id = NEW.operation_id
  )
BEGIN
  INSERT INTO sub_notification (client_id, case_id, submission_id, created_at)
  SELECT client_id, case_id, operation_id, finalized_at FROM submissions_revision
  WHERE client_id = NEW.client_id AND case_id = NEW.case_id AND operation_id = NEW.operation_id;
END;
