-- The offline tests' enrolled identities in client A's D1 (gates.test.ts; crafted issuers, never Clerk users).
INSERT INTO members (app, subject, role, active, joined_at) VALUES
	('client', 'user_crafted_viewer1', 'member', 1, '2026-01-01T00:00:00.000Z'),
	('client', 'user_crafted_viewer2', 'member', 1, '2026-01-01T00:00:00.000Z'),
	('client', 'user_crafted_editor1', 'member', 1, '2026-01-01T00:00:00.000Z'),
	('client', 'user_crafted_firmadmin', 'firm_admin', 1, '2026-01-01T00:00:00.000Z'),
	('staff', 'user_crafted_ga', 'instance_admin', 1, '2026-01-01T00:00:00.000Z');
INSERT INTO assignments (app, subject, case_id, role) VALUES
	('client', 'user_crafted_viewer1', 'case-1', 'viewer'),
	('client', 'user_crafted_viewer2', 'case-2', 'viewer'),
	('client', 'user_crafted_editor1', 'case-1', 'editor');
INSERT INTO invitations (app, email, role, expires_at, created_by, created_at) VALUES
	('client', 'crafted-invitee@example.com', 'member', '2999-01-01T00:00:00.000Z', 'user_crafted_firmadmin', '2026-01-01T00:00:00.000Z'),
	('client', 'crafted-expired@example.com', 'member', '2000-01-01T00:00:00.000Z', 'user_crafted_firmadmin', '2000-01-01T00:00:00.000Z');
