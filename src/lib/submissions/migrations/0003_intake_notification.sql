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
    REFERENCES submissions_set (client_id, case_id, set_id)
);

CREATE TRIGGER sub_notification_on_seal
AFTER UPDATE OF state ON submissions_set
WHEN NEW.state = 'sealed' AND OLD.state = 'sealing'
BEGIN
  INSERT INTO sub_notification (client_id, case_id, submission_id, created_at)
  VALUES (NEW.client_id, NEW.case_id, NEW.set_id, NEW.sealed_at);
END;
