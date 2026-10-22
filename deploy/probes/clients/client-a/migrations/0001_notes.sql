-- Synthetic reviewed migration for client-a (GRS-107). The trusted parent stages and digests this directory; the config's migrations_dir may name only it.
CREATE TABLE notes (id TEXT PRIMARY KEY, body TEXT NOT NULL);
