-- The tables both apps keep in their own D1 (GRS-108). A member is (app, subject): app is the trusted Clerk instance's
-- label ("client" or "staff"), from the deployment's issuer mapping, and subject is that instance's user id. Nothing
-- here is in Clerk, and Clerk holds none of it.
CREATE TABLE members (
	app TEXT NOT NULL CHECK (app IN ('client', 'staff')),
	subject TEXT NOT NULL,
	role TEXT NOT NULL CHECK (role IN ('member', 'firm_admin', 'instance_admin', 'global_admin', 'operator')),
	active INTEGER NOT NULL DEFAULT 1,
	joined_at TEXT NOT NULL,
	PRIMARY KEY (app, subject)
);
CREATE TABLE invitations (
	app TEXT NOT NULL CHECK (app IN ('client', 'staff')),
	email TEXT NOT NULL,
	role TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	created_by TEXT NOT NULL,
	created_at TEXT NOT NULL,
	used_by TEXT,
	used_at TEXT
);
CREATE TABLE audit (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	at TEXT NOT NULL,
	app TEXT,
	subject TEXT,
	action TEXT NOT NULL,
	gate TEXT NOT NULL,
	case_id TEXT,
	outcome TEXT NOT NULL
);
