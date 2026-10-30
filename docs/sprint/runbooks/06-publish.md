# 06: publish a results version to staging from shards

The operator machine builds the version's read model into immutable JSON shards, uploads them to R2, registers the version in staging's D1, records a human sign-off bound to the shard manifest, and publishes. The Worker then serves `/cases/<caseId>/v/<rv>/overview` from the shards. Run every command from the repository root of a checkout at the deployed revision.

Everything `build` writes holds case content. Keep `--out` under `.local/`, which Git ignores.

## Before you start

- Staging's D1 has migrations `0008_shard_publication.sql` and `0010_shard_admission.sql` (`scripts/deploy-staging.sh` applies them; `node node_modules/wrangler/bin/wrangler.js d1 migrations apply clearcase-staging-db --remote --config deploy/staging/wrangler.jsonc` applies them alone).
- The case exists in staging's D1 (`rs_case`). For `v5-demo`, ticket 07's originals load created it.
- `rclone` has the `cc-staging` remote for the `clearcase-staging-files` bucket (runbook 07).
- Wrangler is logged in to the GridShift account (`bunx wrangler whoami`).
- The package was converted against the full case folder (runbook 07, step 2).

## Steps

```sh
CASE_FOLDER=...           # caseFolder in the coordinator's .local/v5-verification.json
PKG=.local/originals-v5-pkg
OUT=.local/publish/v5-demo

# 1. Build: a local import into a throwaway store under $OUT, then every module in scripts/publish/shards/.
bun scripts/publish/cli.ts build --package "$PKG" --case-folder "$CASE_FOLDER" --case-id v5-demo --out "$OUT"

# 2. Upload to views/<rvHex>/ with Cache-Control immutable, manifest.json last, then rclone check. Checks every local
#    file against manifest.json, then compares what R2 already holds byte for byte: any object with other bytes refuses
#    the whole upload before anything is written. It only creates objects; it never replaces one.
bun scripts/publish/cli.ts upload --out "$OUT" --remote cc-staging:clearcase-staging-files

# 3. Register: rs_case (kept), rs_results_version, rs_document, rs_asset, rs_seed, rs_shard_manifest and the manifest's
#    rs_shard_entry rows. A row D1 already holds must be this build's (one with other content refuses); the rows are read
#    back and their digest recomputed as the hosted reader does, and only then is the version stored. A stored version is
#    only verified, never written. Refuses any ASSET_MISSING_AT_BUILD beyond --acknowledged-missing (default 0).
bun scripts/publish/cli.ts register --out "$OUT" --config deploy/staging/wrangler.jsonc

# 4. Sign off: one --ack per warning code of the import, with a reason. The command lists any code you missed.
bun scripts/publish/cli.ts signoff --out "$OUT" --signer you@example.com --config deploy/staging/wrangler.jsonc \
  --ack CITE_UNRESOLVED='...' --ack TEXT_CONTROL_CHARS='...' --ack TEXT_NONE='...' --ack V5_META_COUNT_DISAGREEMENT='...'

# 5. Publish: hashes the manifest.json R2 holds; if a sign-off binds that hash it admits the manifest's shards (the only
#    names the Worker serves) and flips rs_publication.
bun scripts/publish/cli.ts publish --out "$OUT" --config deploy/staging/wrangler.jsonc --remote cc-staging:clearcase-staging-files

# 6. Bind the client's audit log and user-work database (once), and grant the test user viewer on the case
#    (offline owned seed, docs/acceptance/hosting/case-grant-provisioning.md). Without the user-work binding the
#    overview answers 503: its notes summary is refused.
bun scripts/publish/cli.ts grant --case-id v5-demo --email grs249-viewer+clerk_test@example.com \
  --credentials .local/publish/credentials.json --config deploy/staging/wrangler.jsonc
```

Every step can run again. `upload` creates only what R2 lacks. `register` writes only the rows D1 lacks and verifies the rest. `signoff` with the same signer and acknowledgements reports "already signed off" and records nothing. `publish` of the current version changes nothing. `grant` replays its first operation.

A rebuild writes a new manifest (`builtAt` differs). While the version is unpublished, `register` moves the registered manifest to it, and the sign-off has to be recorded again; `upload` refuses the new manifest.json if R2 already holds the old one, so rebuild an unpublished version only before its first upload, or into a new version. Once the version is published, its manifest stays the one its sign-off bound: D1 refuses any other, and `upload` never replaces an object.

The Worker serves a version only the names its admitted manifests list (`rs_shard_manifest.admitted_json`, read with the publication row). A shard R2 holds that no admitted manifest names answers 404 before any cache or R2 read; an admitted shard whose stored size differs answers 503 and is not cached.

## Add a shard family to a published version (tickets 12 to 15)

A ticket that adds `scripts/publish/shards/<family>.ts` (default export `{ name: '<family>', build }`, names not yet in the version) publishes it to the version already on staging as an amendment. It edits no framework file and changes nothing already published. Use the same `$OUT` the version was built into (it holds `register.json` and `shards/manifest.json`).

```sh
FAMILY=views-analysis     # the module's `name`

# 1. Build only that module, over the same package. Writes its shards and amendments/<sha256>.json into $OUT/shards/.
#    Refuses a name the signed manifest already lists, and a package that is another version.
bun scripts/publish/cli.ts build --family "$FAMILY" --package "$PKG" --case-folder "$CASE_FOLDER" --case-id v5-demo --out "$OUT"

# 2. Upload the family's shards, then the amendment. Refuses before writing anything if R2 holds any of them with other bytes.
bun scripts/publish/cli.ts upload --family "$FAMILY" --out "$OUT" --remote cc-staging:clearcase-staging-files

# 3. Register the amendment: rs_shard_amendment (case, version, parent manifest, family) and its rs_shard_entry rows.
#    Refuses unless the version's manifest is published, and refuses a name the version already serves.
bun scripts/publish/cli.ts amend --family "$FAMILY" --out "$OUT" --config deploy/staging/wrangler.jsonc

# 4. Its own sign-off, bound to the amendment's sha256, with the version's warning acknowledgements.
bun scripts/publish/cli.ts signoff --family "$FAMILY" --out "$OUT" --signer you@example.com --config deploy/staging/wrangler.jsonc --ack ...

# 5. Admit it: one statement checks the sign-off, that R2 holds this amendment, that its parent is the admitted
#    manifest and that none of its names is admitted yet, then adds its names to the served set.
bun scripts/publish/cli.ts publish --family "$FAMILY" --out "$OUT" --config deploy/staging/wrangler.jsonc --remote cc-staging:clearcase-staging-files
```

Every step can run again. Two tickets can amend the same version in either order; a second amendment naming a shard another has admitted is refused at `amend` or `publish`. The original `manifest.json`, its sign-offs and `published_at` stay as they are.

## Sign off as the owner

A sign-off is an attestation: each signer's is recorded beside the others (`pub_shard_signoff`, one `signoff_id` each) and none replaces another. The v5 publication on staging was signed by the builder agent (`grs249-builder@clearcase.invalid`); the owner attests it from their own machine, with no rebuild or re-upload:

```sh
bun scripts/publish/cli.ts signoff --out "$OUT" --signer <owner email> --config deploy/staging/wrangler.jsonc \
  --ack CITE_UNRESOLVED='...' --ack TEXT_CONTROL_CHARS='...' --ack TEXT_NONE='...' --ack V5_META_COUNT_DISAGREEMENT='...'
```

It prints `attested by <agent>, <owner>`. Add `--family <name>` to attest an amendment. Run it yourself: the CLI records the email it is given and cannot tell who typed it.

## Migration 0010 on a version published before it

`0010_shard_admission.sql` copies existing sign-offs into `pub_shard_signoff`, but a version published before it has no admitted names, so its pages answer 404 until it is admitted. Run `register` (writes the manifest's entries and verifies the stored rows; nothing else changes) and then `publish` (admits the signed manifest; the publication row and `published_at` stay). Both use the original `$OUT`, unchanged.

## The test user

- Email: `grs249-viewer+clerk_test@example.com`, in the staging client Clerk app (`outgoing-walrus-1020`).
- Verification code: `424242` (Clerk test mode; not a secret).
- The password is generated by `grant` and kept only in `.local/publish/credentials.json` (mode 0600). That file is the journeys' `CREDENTIALS_JSON`.
- The user holds `viewer` on `v5-demo` and nothing else. Any other signed-in user gets 404 or 403 for the case.

## Check

- `/cases/v5-demo` redirects to `/cases/v5-demo/v/<rv>/overview`.
- The overview shows the document count, the version pill (`Version <first 8 hex>`, publication time and documents), and the freshness slot.
- Every other sidebar entry opens the coming-soon panel; `/cases/v5-demo/v/<rv>/system/backup_tab` answers 404.
- `MODE=hosted BASE_URL=<staging origin> CASE_ID=v5-demo EXPECTED_DOCUMENTS=<count> CREDENTIALS_JSON=.local/publish/credentials.json` with J1 and J2 (`tests/journeys/README.md`), inside `orch-bin/browser-lock`.

## Undo

Nothing here deletes. To stop serving a version, withdraw it through the publication owner's path (`rs_version_withdrawal`). Shards under `views/<rvHex>/` are immutable and may stay.
