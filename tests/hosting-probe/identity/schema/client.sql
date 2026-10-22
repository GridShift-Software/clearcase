-- A client instance's case store (GRS-108): its cases, documents (extracted text), Notes (user work), case
-- assignments and operator grants, all in this instance's D1. Assets are in its R2 under cases/<case>/<kind>/.
CREATE TABLE cases (id TEXT PRIMARY KEY, title TEXT NOT NULL);
CREATE TABLE documents (case_id TEXT NOT NULL REFERENCES cases (id), id TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (case_id, id));
CREATE TABLE notes (
	id TEXT PRIMARY KEY,
	case_id TEXT NOT NULL REFERENCES cases (id),
	author_app TEXT NOT NULL,
	author_subject TEXT NOT NULL,
	request_id TEXT NOT NULL,
	body TEXT NOT NULL,
	created_at TEXT NOT NULL,
	UNIQUE (case_id, request_id)
);
CREATE TABLE assignments (
	app TEXT NOT NULL CHECK (app = 'client'),
	subject TEXT NOT NULL,
	case_id TEXT NOT NULL REFERENCES cases (id),
	role TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
	PRIMARY KEY (app, subject, case_id)
);
CREATE TABLE operator_grants (
	id TEXT PRIMARY KEY,
	app TEXT NOT NULL CHECK (app = 'staff'),
	subject TEXT NOT NULL,
	case_id TEXT NOT NULL REFERENCES cases (id),
	granted_by TEXT NOT NULL,
	expires_at TEXT NOT NULL,
	created_at TEXT NOT NULL,
	revoked_at TEXT
);
