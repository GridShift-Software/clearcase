-- Sprint ticket 06 (GRS-249): publication from per-version JSON shards, built and uploaded by the operator machine
-- (scripts/publish/). Staging copy: deploy/staging/migrations/0008_shard_publication.sql, byte for byte. Additive only:
-- previews share staging's database.
--
-- rs_shard_manifest: the shard set a stored version is served from. `prefix` is `views/<rvHex>/` in the client bucket and
-- `manifest_sha256` the hex sha256 of the canonical `manifest.json` under it. Nothing re-hashes a shard on read.
CREATE TABLE rs_shard_manifest (
  version_id TEXT PRIMARY KEY REFERENCES rs_results_version,
  prefix TEXT NOT NULL CHECK (prefix = 'views/' || substr(version_id, 8) || '/'),
  manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
  built_at TEXT NOT NULL
);

-- pub_version_signoff: a person's sign-off of one stored version, bound to its package manifest, its shard manifest and the
-- validation it was read with. `acknowledgements_json` names each warning code the signer accepted, with a reason. A
-- sign-off is a record: it is never changed or removed, and a new shard manifest needs a new sign-off.
CREATE TABLE pub_version_signoff (
  version_id TEXT NOT NULL REFERENCES rs_results_version,
  results_version TEXT NOT NULL CHECK (results_version = version_id),
  manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64),
  shard_manifest_sha256 TEXT NOT NULL CHECK (length(shard_manifest_sha256) = 64 AND shard_manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
  validator_version TEXT NOT NULL,
  diagnostics_sha256 TEXT NOT NULL,
  acknowledgements_json TEXT NOT NULL CHECK (json_valid(acknowledgements_json) AND json_type(acknowledgements_json) = 'array'),
  signer TEXT NOT NULL CHECK (length(signer) BETWEEN 3 AND 254 AND signer GLOB '*?@?*'),
  signed_at TEXT NOT NULL,
  PRIMARY KEY (version_id, shard_manifest_sha256)
);
CREATE TRIGGER pub_version_signoff_fixed BEFORE UPDATE ON pub_version_signoff
  BEGIN SELECT RAISE(ABORT, 'pub_version_signoff: a sign-off is never changed'); END;
CREATE TRIGGER pub_version_signoff_kept BEFORE DELETE ON pub_version_signoff
  BEGIN SELECT RAISE(ABORT, 'pub_version_signoff: a sign-off is never removed'); END;

-- When the pointer last moved to its version; null on a row the staged publication flow wrote.
ALTER TABLE rs_publication ADD COLUMN published_at TEXT;
