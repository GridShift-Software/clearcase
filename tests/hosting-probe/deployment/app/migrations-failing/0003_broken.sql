-- Fails on its second statement: the probe records whether the first one stays applied and whether the migration is
-- recorded as applied.
INSERT INTO notes (id, body) VALUES ('from-0003', 'written before the failure');
INSERT INTO no_such_table (id) VALUES ('x');
