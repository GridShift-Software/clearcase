# Runbook 07: load the v5 originals into staging

Ticket GRS-250. Loads every original the v5 package references into the staging bucket, keyed `orig/<sha256>`, and the rows that let the existing originals route find them. Nothing passes through the Worker.

## Who holds what
- **R2 token:** the owner created one Object Read & Write token scoped to `clearcase-staging-files` (EU jurisdiction). It lives only in the operator machine's rclone config, as the remote `cc-staging` (`rclone config show cc-staging` prints it; never paste that output anywhere).
- **Cloudflare API token for wrangler:** the operator's `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, from the environment. D1 `clearcase-staging-db` and the bucket belong to ticket 02's staging environment.
- No token value is in Git, this runbook or a log. `load.sh` never echoes one.

## What goes where
All outputs stay under the ignored `.local/`. The case folder is read-only; `RAWS/` is never touched.

| File | Content |
| --- | --- |
| `.local/originals-v5-pkg/` | the converted package (against the full case folder) |
| `.local/originals-v5/orig-stage/<sha256>` | hard links to the unique originals (symlinks if the folder is on another filesystem) |
| `.local/originals-v5/files-from.txt` | the rclone `--files-from` list: one sha256 per unique original |
| `.local/originals-v5/manifest.json` | `path`, `sha256`, `size`, `mediaType`, `assetId` per referenced file asset |
| `.local/originals-v5/sql/*.sql` | `rs_case` (`INSERT OR IGNORE`), `rs_original` (`ON CONFLICT DO UPDATE` for `etag` and `media_family`), `rs_case_original` (`INSERT OR IGNORE`), in batches of 50 rows |
| `.local/originals-v5/remote-etags.json` | the stored objects with their real R2 ETags (S3 listing) |

Rows: one `rs_original` per unique sha256 (67 refs share bytes, so those share a row), one `rs_case_original` per referenced file asset (asset id = register ref). The 57 package-file PDFs and the 1,308 embedded e-mail attachments get no rows and no upload; the document page says "inside the parent message" for the embedded ones. Genuine missing originals stay missing.

## Steps
1. **Convert against the full case folder** (never the 1,140-file subset):
   ```
   bun scripts/case-package/cli.ts convert --html "$CASE_FOLDER/<workspace>.html" --case-folder "$CASE_FOLDER" --case-id v5-demo --out .local/originals-v5-pkg --report .local/originals-v5-report.json
   ```
2. **Manifest** (prints the counts the acceptance lines compare against):
   ```
   bun scripts/originals/manifest.ts --package .local/originals-v5-pkg --case-folder "$CASE_FOLDER" --case-id v5-demo --out .local/originals-v5
   ```
3. **Migration 0009** on staging D1, once (`deploy/staging/migrations/0009_rs_original_etag.sql` is a byte copy of `src/lib/storage/cloud/migrations/0003_rs_original_etag.sql`):
   ```
   bunx wrangler d1 migrations apply clearcase-staging-db --remote --config deploy/staging/wrangler.jsonc
   ```
4. **Upload, check, ETags** (`CASE_FOLDER` must be set; add `CASE_LABEL` only if the label may appear on staging):
   ```
   CASE_FOLDER=... scripts/originals/load.sh upload
   ```
   It runs `rclone copy --files-from ... --s3-chunk-size 64M --s3-upload-cutoff 200M --transfers 16 --size-only` to `cc-staging:clearcase-staging-files/orig/`, then `rclone check --one-way`, then `scripts/originals/etags.ts`, which lists `orig/` over the S3 API (rclone's own listing cannot give a multipart object's composite ETag, which R2 compares in a conditional read).
5. **D1 rows** (regenerates the SQL with the ETags, then one `wrangler d1 execute ... --remote --file` per batch):
   ```
   CASE_FOLDER=... scripts/originals/load.sh d1
   ```
   `load.sh all` runs 4 and 5 together.

## Verify
- `rclone check` printed 0 differences (step 4 stops otherwise).
- `bunx wrangler d1 execute clearcase-staging-db --remote --config deploy/staging/wrangler.jsonc --command "select count(*) from rs_original"` equals the manifest's unique sha256 count; `select count(*) from rs_case_original where case_id='v5-demo'` equals its file assets; `select count(*) from rs_original where etag is null` is 0.
- Re-run `load.sh upload`: rclone reports 0 B transferred. Re-run `load.sh d1`: the counts do not move.
- Open a PDF, an `.eml` and a JPEG under 16 MiB at `/cases/v5-demo/originals/<assetId>` on staging and note the time. Originals over 16 MiB open once ticket 08 lands.

## Failure notes
- A killed upload is safe to re-run; rclone skips objects whose size matches (the key is the content hash).
- `rclone check` or the ETag listing naming a missing object: re-run `upload`.
- `manifest.ts` refuses when the case folder no longer matches `assets.json` (size) or when an object has no ETag, a different size or is absent.
