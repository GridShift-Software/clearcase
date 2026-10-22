-- The offline tests' enrolled identities in the staff app's D1 (gates.test.ts).
INSERT INTO members (app, subject, role, active, joined_at) VALUES
	('staff', 'user_crafted_ga', 'global_admin', 1, '2026-01-01T00:00:00.000Z'),
	('staff', 'user_crafted_operator', 'operator', 1, '2026-01-01T00:00:00.000Z');
