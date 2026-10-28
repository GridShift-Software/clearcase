# 18: Bundles
**Wave:** 2 · **Size:** 1–1.5 d · **Security-sensitive:** no · **Suggested agent:** strong (Opus / Sol)
## What to build
On staging a lawyer sees the discovery schedule, the court bundle list and the CaseLines index with links to the originals, builds a court bundle from chosen documents, downloads it as a PDF, saves it, and still finds it with its assembled PDF after a reload. Downloads of originals go through asset links; large ones through presigned URLs (08). J9 passes on staging, and the local "assembled PDF lost after reload" defect is fixed where cheap.

How: `research/view-contracts.md` family E and P6. Builder modules `scripts/publish/shards/bundle-paths.ts` (`bundle-paths.json` = 04's `BundlePathsShard`: `pathIndex` of `documentRows` plus `packageFileAssets` → `{ path → { ref | assetKey, presentation } }`) and `shards/views-bundles.ts` (`view/discovery_tab.json`, `view/court_bundle_tab.json` with `bundlesOf` already applied and locators resolved, `view/caselines_tab.json`). Hosted twins of the forbidden local modules: `src/lib/views/bundles/links.hosted.ts` builds `files` and `downloads` hrefs from asset ids with `locals.assets.links` (one call per page, or a lazy link to `originals/[assetId]`), `store.hosted.ts` reads and writes `bundles_custom` and `bundles_schedule_mark` through 16's adapter (`listTableRows`, `putTableRow`) and `discovery-mode`, `bundle-header`, `caselines-links` through `listRows`/`putRow`. Hosted routes under the version folder: `bundles/{discovery_tab,court_bundle_tab,caselines_tab}/` with loaders and the local actions (`select`, `co`, `mode`; `header`, `restore`, `clear`, `save`, `delete`; `link`, `unlink`) over the adapter; CaseLines search runs server-side over the shard as locally. Assembled PDF persistence: `bundles/court_bundle_tab/assembled/+server.ts` `POST` takes the browser-built PDF (multipart, cap 64 MiB), stores it once at `work/<caseId>/bundles/<bundleId>/<sha256>.pdf` with `writeOnce`, and records `assembledSha256` and `bytes` on the `bundles_custom` row; `GET ?id=` serves it authorized (1 D1, 1 R2 stream, attachment disposition). The local store gets the same field and a local file under the data dir if it is under an hour of work, else a Low. Table definitions for the two `uw_table_row` tables are registered by migration `src/lib/user-work/hosted/migrations/0002_bundle_tables.sql` (staging `0011`) as `uw_table_definition` rows matching `defineTable`'s stored shape; if that shape cannot be seeded by SQL, a one-off `bun scripts/bundles/register-tables.ts` against staging, documented in the runbook. Hooks on `Builder.svelte` and the court bundle page: `bundle-build`, `bundle-name`, `bundle-files`, `bundle-create`, `bundle-download`, `bundle-save`, `bundle-heading`. Flip the three `hostedStatus` lines.
## Reserved paths (edit only these; new files under them are fine)
- `deploy/client/routes/cases/[caseId]/v/[version]/bundles/`
- `scripts/publish/shards/{bundle-paths.ts,views-bundles.ts}`, `scripts/bundles/`
- `src/lib/views/bundles/` (all), `src/lib/bundles/`, `src/routes/v/[vid]/bundles/`
- `src/lib/user-work/hosted/migrations/0002_bundle_tables.sql`, `deploy/staging/migrations/0011_bundle_tables.sql`
- `src/lib/views/hosted/availability.ts` (the three lines only)
- `tests/bundles/18-*.test.ts`, `tests/publication/shards/18-bundles.test.ts`, `tests/hosted-foundation/budget/18-bundles.test.ts`, `docs/sprint/runbooks/18-bundles.md`
Shared files this ticket owns, which others must not edit until it merges: none.
## Blocked by
- 06 TRACER · 16 Notes, plus the user-work adapter (both merged into the sprint branch)
## Acceptance
- [ ] J9 on staging: open the court bundle view, add two synthetic PDFs through `bundle-files`, name it in `bundle-name`, `bundle-create`, `bundle-download` yields a valid PDF containing both sources (`pdfinfo` page count, `pdftotext` markers), `bundle-save`, reload, the saved name is listed and its assembled PDF downloads; build under 5 s, save under 2 s; timings in the PR.
- [ ] Discovery schedule and CaseLines index render from shards with `files` and `downloads` links that resolve to the originals route; a CaseLines search returns hits; marks and links persist across a reload.
- [ ] Builder: `bundle-paths.json` and the three view shards match their types on the synthetic fixture (`tests/publication/shards/18-bundles.test.ts`); the court bundle shard is the transformed rows, not the 1.6 MB raw dataset.
- [ ] Budget (`tests/hosted-foundation/budget/18-bundles.test.ts`): each bundle page view at most 2 D1 queries beyond authorization (table rows, register rows) and 1 R2 cold; the assembled-PDF POST is one `writeOnce` plus one D1 batch; the GET streams with 1 D1 and 1 R2 and never buffers the whole file.
- [ ] A user without a grant cannot fetch another case's assembled PDF by id (404 after 1 D1); the POST refuses non-PDF bytes and anything over 64 MiB.
## Checks (run exactly these; paste the results in the PR)
```
bun install --frozen-lockfile && bunx svelte-kit sync && scripts/agent-tools/doctor
bunx tsc --noEmit -p .
bunx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings
bunx vitest related <changed src files> --run
bun run --bun test tests/bundles tests/publication/shards src/lib/bundles src/lib/views tests/hosted-foundation/user-work tests/hosted-foundation/budget
bun run --bun check:hosted-imports && bun run --bun build:hosted
scripts/preview.sh      # walk J9, discovery and CaseLines, note ms
```
## Read first
`research/view-contracts.md` section 1 (bundles rows), 2 (E), 4 (item 9), 5 (P6); `research/ui-spec.md` section 18; `research/journeys.md` J9 hooks; `scripts/ci/hosted-imports.ts` line 8 (the forbidden local modules); 16's ticket (adapter).
## Decisions already made (don't re-decide)
- `links.server.ts` and `store.server.ts` stay local-only; hosted uses the two twins. The builder stores transformed court-bundle rows and a path index; the Worker resolves hrefs from asset ids.
- Package-file PDFs (the 57 shipped bundle and schedule PDFs) are not uploaded in this sprint (07): their download links show "not available on hosted" rather than a broken link.
- Assembled PDFs are stored in the client bucket under `work/<caseId>/bundles/`, written once, served authorized through the Worker; no presigned upload.
- Custom bundles and marks live in `uw_table_row`; header, mode and CaseLines links in `uw_register_row`; definitions registered once per deployment.
- No tray, sharing, version comparison or server-side assembly.
## Forbidden
Editing outside the reserved paths; `dev` or `main`; real case material or secrets in Git; new guards, receipts or process files; a second review round; loosening tests; redeploying sandboxes A or B; editing the adapter (16's), `assets.ts`, `objects.ts` or the viewer (08's; call `writeOnce` and `links` as they are), the builder framework (06's), `payloads/*` (04's; add `payloads/18-bundles.ts` if a type is missing), `hosted-imports.ts` (03's).
## Done means
PR merged into sprint/hosted-demo-20261105 with a merge commit; staging deployed at that SHA; J9 passes there; the Linear issue is Done with the merge SHA; Lows go as a `follow-ups:` comment on the issue.
