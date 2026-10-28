# 07: v5 originals on staging
**Wave:** 1 · **Size:** 0.5 d · **Security-sensitive:** no · **Suggested agent:** standard (Sonnet / Terra)
## What to build
The operator converts the real v5 export against the full case folder, and every referenced original (about 1,744 files, 1.85 GB of unique bytes, including the 35 over 16 MiB and the 258 MB bundle) is in staging's bucket, keyed by content hash, with D1 rows that the existing originals route resolves. A re-run skips what is already stored. Any v5 original up to 16 MiB opens on staging through the existing route today; larger ones open once 08 lands.

How: `research/data-path.md` section 2 steps 1 and 3 and section 5. `scripts/originals/manifest.ts` reads the converted package's `assets.json` and the case folder and writes, into `.local/`, an rclone `--files-from` list, a `path → sha256,size,mediaType,assetId` manifest, and SQL for `rs_case` (`INSERT OR IGNORE`), `rs_original(sha256, size, object_key, etag, media_family)` and `rs_case_original(case_id, asset_id, sha256, filename, media_type, finalized_at)`, in multi-row batches of 50. The object key is the existing `orig/<sha256>` (`src/lib/storage/cloud/keys.ts`), so the deployed viewer and `rs_original.object_key` agree. `scripts/originals/load.sh` runs `rclone copy --files-from ... --s3-chunk-size 64M --s3-upload-cutoff 200M --transfers 16` to `cc-staging:clearcase-staging-files/orig/` using a copy-dest layout that renames each file to its sha256 (write the list as `rclone copyto` pairs or stage hard links under `.local/orig-stage/<sha256>` first), then `rclone check`, then `rclone lsjson --hash` to collect each object's ETag into the SQL, then `wrangler d1 execute clearcase-staging-db --remote --file` per batch. Migration `src/lib/storage/cloud/migrations/0003_rs_original_etag.sql` (copy at `deploy/staging/migrations/0009_rs_original_etag.sql`) adds nullable `etag TEXT` and `media_family TEXT` to `rs_original`; `media_family` is one of `pdf`, `image`, `email-text`, `download` from the asset's media type (`src/lib/case-package/media.ts`). Shared sha256 across refs (67 in v5) gets one `rs_original` row and several `rs_case_original` rows. Embedded attachments (1,308) get no rows; the document page says "inside the parent message" (12).
## Reserved paths (edit only these; new files under them are fine)
- `scripts/originals/`
- `src/lib/storage/cloud/migrations/0003_rs_original_etag.sql`, `deploy/staging/migrations/0009_rs_original_etag.sql`
- `tests/hosted-foundation/storage/07-*.test.ts`
- `docs/sprint/runbooks/07-originals.md`
Shared files this ticket owns, which others must not edit until it merges: none.
## Blocked by
- 02 Staging environment (merged into the sprint branch; the owner's R2 S3 token must exist)
## Acceptance
- [ ] `bun scripts/originals/manifest.ts --package <dir> --case-folder <dir> --case-id v5-demo --out .local/originals-v5` on the synthetic fixture produces a list whose count equals the fixture's file assets and SQL that applies cleanly to a fresh local D1 after migration 0003 (`tests/hosted-foundation/storage/07-originals-manifest.test.ts`).
- [ ] On staging after the load: `rclone check` reports 0 differences; `select count(*) from rs_original` equals the unique sha256 count the manifest printed; `rs_case_original` rows equal the referenced file-asset count; every `rs_original.etag` is non-null.
- [ ] Re-running `load.sh` transfers 0 bytes and the SQL is idempotent (`INSERT OR IGNORE` / `ON CONFLICT DO UPDATE` for etag).
- [ ] On staging, three v5 originals under 16 MiB (a PDF, an `.eml`, a JPEG) open at `/cases/v5-demo/originals/<assetId>` with the right disposition (J4 step 3 for the small and medium bands; the 258 MB band waits for 08).
- [ ] The runbook names the token holder, the rclone remote and the exact commands; no token value anywhere.
## Checks (run exactly these; paste the results in the PR)
```
bun install --frozen-lockfile && bunx svelte-kit sync && scripts/agent-tools/doctor
bunx tsc --noEmit -p .
bunx vitest related <changed src files> --run
bun run --bun test tests/hosted-foundation/storage tests/hosted-foundation/native-schema
scripts/preview.sh      # open the three originals on the preview (shared staging bucket), note ms
```
## Read first
`research/data-path.md` sections 1, 2, 5; `docs/results-package.md` (assets and identity); `src/lib/storage/cloud/keys.ts`, `migrations/0001_rs_results_storage.sql`; `research/cloudflare-ops.md` section 4 (R2 token) and `architecture.md` section 3 (rclone flags).
## Decisions already made (don't re-decide)
- Convert against the full case folder; never build from the 1,140-file subset. Genuine missing originals stay missing and are acknowledged at sign-off (06).
- Key is `orig/<sha256>` with no prefix directory; asset id is the register ref, as today. The viewer resolves by asset id through `rs_case_original`.
- Only referenced originals are uploaded; the 57 package-file PDFs are not uploaded in this sprint (bundle downloads are 18's).
- `etag` and `media_family` live on `rs_original` and are written here; 08 reads them for conditional ranged gets and for choosing the delivery family without probing bytes.
- Case id `v5-demo`; the case label from the package may be real on staging but appears nowhere in Git or the PR.
- rclone from the operator machine over the S3 API with the owner's token; nothing passes through the Worker.
## Forbidden
Editing outside the reserved paths; `dev` or `main`; real case material or secrets in Git (manifests and SQL for v5 stay in `.local/`); new guards, receipts or process files; a second review round; loosening tests; redeploying sandboxes A or B; editing `assets.ts`, `objects.ts`, `intake.ts` or the viewer (08's); editing `scripts/publish/` (06's).
## Done means
PR merged into sprint/hosted-demo-20261105 with a merge commit; staging deployed at that SHA; the v5 originals loaded and J4 step 3 (small and medium bands) passes on staging; the Linear issue is Done with the merge SHA; Lows go as a `follow-ups:` comment on the issue.
