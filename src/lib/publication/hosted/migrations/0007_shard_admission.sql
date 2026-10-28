-- Sprint ticket 06 (GRS-249), review fixes H1 and M3: the signed publication governs what is served, and a sign-off is an
-- attestation. Staging copy: deploy/staging/migrations/0010_shard_admission.sql, byte for byte. Additive only: previews
-- share staging's database.
--
-- A version serves exactly the shards its admitted manifests name: its signed manifest.json, then each amendment that
-- adds a family to it. `rs_shard_entry` lists every shard a manifest or an amendment names; `rs_shard_admission` records
-- which of them `publish` admitted; `rs_shard_manifest.admitted_json` is the admitted names with their bytes, recomputed
-- in the admitting statement and read with the publication row. Every table here is append-only.

-- One shard a manifest or an amendment names. `manifest_sha256` is the hex sha256 of the manifest.json or amendment file
-- that lists it; names under `amendments/` and manifest.json itself are the lists, not shards.
CREATE TABLE rs_shard_entry (
  version_id TEXT NOT NULL REFERENCES rs_results_version,
  manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 6 AND 520 AND name GLOB '*.json' AND name <> 'manifest.json' AND name NOT GLOB 'amendments/*'),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  bytes INTEGER NOT NULL CHECK (bytes >= 0),
  PRIMARY KEY (version_id, manifest_sha256, name)
);
CREATE TRIGGER rs_shard_entry_fixed BEFORE UPDATE ON rs_shard_entry
  BEGIN SELECT RAISE(ABORT, 'rs_shard_entry: an entry is never changed'); END;
CREATE TRIGGER rs_shard_entry_kept BEFORE DELETE ON rs_shard_entry
  BEGIN SELECT RAISE(ABORT, 'rs_shard_entry: an entry is never removed'); END;

-- An amendment: one shard family added to a version, bound to the case, the version and the manifest it extends (its
-- parent, the version's signed manifest.json). `amendment_sha256` is the hex sha256 of its canonical JSON, which R2
-- holds at `views/<rvHex>/amendments/<amendment_sha256>.json`; its shards are its rs_shard_entry rows.
CREATE TABLE rs_shard_amendment (
  version_id TEXT NOT NULL REFERENCES rs_results_version,
  amendment_sha256 TEXT NOT NULL CHECK (length(amendment_sha256) = 64 AND amendment_sha256 NOT GLOB '*[^0-9a-f]*'),
  case_id TEXT NOT NULL,
  parent_sha256 TEXT NOT NULL CHECK (length(parent_sha256) = 64 AND parent_sha256 NOT GLOB '*[^0-9a-f]*'),
  family TEXT NOT NULL CHECK (length(family) BETWEEN 1 AND 64),
  shards INTEGER NOT NULL CHECK (shards > 0),
  registered_at TEXT NOT NULL,
  PRIMARY KEY (version_id, amendment_sha256)
);
CREATE TRIGGER rs_shard_amendment_fixed BEFORE UPDATE ON rs_shard_amendment
  BEGIN SELECT RAISE(ABORT, 'rs_shard_amendment: an amendment is never changed'); END;
CREATE TRIGGER rs_shard_amendment_kept BEFORE DELETE ON rs_shard_amendment
  BEGIN SELECT RAISE(ABORT, 'rs_shard_amendment: an amendment is never removed'); END;

-- A manifest or amendment `publish` admitted into the version's served set. Admission recomputes admitted_json in the same
-- statement, so a reader sees a set either with or without it.
CREATE TABLE rs_shard_admission (
  version_id TEXT NOT NULL REFERENCES rs_results_version,
  manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64 AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
  admitted_at TEXT NOT NULL,
  PRIMARY KEY (version_id, manifest_sha256)
);
CREATE TRIGGER rs_shard_admission_fixed BEFORE UPDATE ON rs_shard_admission
  BEGIN SELECT RAISE(ABORT, 'rs_shard_admission: an admission is never changed'); END;
CREATE TRIGGER rs_shard_admission_kept BEFORE DELETE ON rs_shard_admission
  BEGIN SELECT RAISE(ABORT, 'rs_shard_admission: an admission is never removed'); END;

-- The admitted names of the version with their bytes, `{"shell.json": 1234, ...}`; null until its manifest is admitted.
ALTER TABLE rs_shard_manifest ADD COLUMN admitted_json TEXT CHECK (admitted_json IS NULL OR (json_valid(admitted_json) AND json_type(admitted_json) = 'object'));
CREATE TRIGGER rs_shard_admission_admit AFTER INSERT ON rs_shard_admission
  BEGIN
    UPDATE rs_shard_manifest SET admitted_json = (
      SELECT json_group_object(e.name, e.bytes) FROM rs_shard_entry e
      JOIN rs_shard_admission a ON a.version_id = e.version_id AND a.manifest_sha256 = e.manifest_sha256
      WHERE e.version_id = NEW.version_id)
    WHERE version_id = NEW.version_id;
  END;
-- Once admitted, the version's manifest is the one its sign-off bound.
CREATE TRIGGER rs_shard_manifest_admitted BEFORE UPDATE OF manifest_sha256 ON rs_shard_manifest
  WHEN EXISTS (SELECT 1 FROM rs_shard_admission WHERE version_id = OLD.version_id)
  BEGIN SELECT RAISE(ABORT, 'rs_shard_manifest: an admitted manifest is never replaced'); END;

-- pub_shard_signoff: a person's attestation of one manifest or amendment of a stored version, bound to the package
-- manifest and the validation it was read with. Each row is its own attestation (`signoff_id`); the same signer, target
-- and acknowledgements are one attestation however often they are replayed. It supersedes pub_version_signoff, whose
-- rows are copied here and which nothing writes again.
CREATE TABLE pub_shard_signoff (
  signoff_id INTEGER PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES rs_results_version,
  -- The signed manifest.json or amendment, as hex sha256.
  shard_manifest_sha256 TEXT NOT NULL CHECK (length(shard_manifest_sha256) = 64 AND shard_manifest_sha256 NOT GLOB '*[^0-9a-f]*'),
  manifest_sha256 TEXT NOT NULL CHECK (length(manifest_sha256) = 64),
  validator_version TEXT NOT NULL,
  diagnostics_sha256 TEXT NOT NULL,
  acknowledgements_json TEXT NOT NULL CHECK (json_valid(acknowledgements_json) AND json_type(acknowledgements_json) = 'array'),
  signer TEXT NOT NULL CHECK (length(signer) BETWEEN 3 AND 254 AND signer GLOB '*?@?*'),
  signed_at TEXT NOT NULL,
  UNIQUE (version_id, shard_manifest_sha256, signer, acknowledgements_json)
);
CREATE TRIGGER pub_shard_signoff_fixed BEFORE UPDATE ON pub_shard_signoff
  BEGIN SELECT RAISE(ABORT, 'pub_shard_signoff: a sign-off is never changed'); END;
CREATE TRIGGER pub_shard_signoff_kept BEFORE DELETE ON pub_shard_signoff
  BEGIN SELECT RAISE(ABORT, 'pub_shard_signoff: a sign-off is never removed'); END;
INSERT INTO pub_shard_signoff (version_id, shard_manifest_sha256, manifest_sha256, validator_version, diagnostics_sha256, acknowledgements_json, signer, signed_at)
  SELECT version_id, shard_manifest_sha256, manifest_sha256, validator_version, diagnostics_sha256, acknowledgements_json, signer, signed_at
  FROM pub_version_signoff ORDER BY signed_at, version_id;
