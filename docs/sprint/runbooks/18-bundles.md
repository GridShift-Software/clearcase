# Publish and verify bundles

Apply staging migration `0011_bundle_tables.sql` only when it is the only pending migration. It seeds the adapter's stored `uw_table_definition` shape for `bundles_custom` and `bundles_schedule_mark`. The equivalent client migration is `src/lib/user-work/hosted/migrations/0002_bundle_tables.sql`. No request registers a definition.

Follow [Add a shard family to a published version](06-publish.md#add-a-shard-family-to-a-published-version-tickets-12-to-15) for `bundle-paths`, then `views-bundles`. Hold `/tmp/clearcase-staging-publish.lock` with `flock` during each command. Use signer `grs264-builder@clearcase.invalid`. Never replace the original manifest or another family's objects.

On this SvelteKit 3 branch, Bun cannot resolve the virtual `$app/tsconfig` paths while importing all shard modules. Supply an ignored tsconfig with an absolute `$lib/*` path mapping using `bun --tsconfig-override <file> scripts/publish/cli.ts ...`. This changes no shard framework file.

The bundle view shards embed their path index to keep each page's cold read to one R2 object. Package-file PDFs have no hosted download: only indexed document originals get lazy authorized originals links. CaseLines searches its shard on the server.

The browser posts the raw assembled PDF (`application/pdf`) with a required Content-Length and percent-encoded item metadata in the `x-bundle` header (24 KiB encoded limit), plus `x-bundle-id`, to `court_bundle_tab/assembled`. The endpoint requires an editor grant, refuses missing or oversized lengths before reading, checks the PDF magic as bytes arrive, reads into one preallocated buffer, hashes that buffer without copying it,, and calls `writeOnce` under `work/<caseId>/bundles/<bundleId>/<sha256>.pdf`. Only after that succeeds does it save the hash and size with the custom bundle row. A failed database write may leave an unreferenced immutable object; it releases no link. GET authorizes the URL's case before looking up the bundle and streams the saved object as an attachment.

Local saves use the same endpoint shape. A private `assembled.json` sidecar and PDF under the data directory preserve the existing registered local table schema. Reload reads the sidecar, so an existing store does not need a table migration. Deleting a bundle removes its list entry; immutable assembled files remain for recovery.

Run J9 through the browser lock with an editor's saved session, `SIGN_IN_MS=20000`, and no `CREDENTIALS_JSON`. Capture the POST's `Server-Timing`: object storage, user-work save, and total; measure reload separately. Validate both downloaded PDFs with `pdfinfo` and `pdftotext`. Delete the synthetic bundle after the run.

Known adapter limit: `listTableRows` reads the client binding, table definition, then rows; a header register adds another query. The tests pin measured ceilings (four table-plus-header reads, three assembled lookup reads, two mutation batches). The ticket targets of two, one, and one are NOT MET because of the shared adapter. The coordinator’s latency branch may lower these ceilings. Non-note table writes also use the adapter's separate audit acknowledgement batch. This ticket cannot edit that adapter.

Discovery actions accept at most 200 keys per request; the browser splits larger selections by both byte size and key count. Each action checks all C/O bases before writing, then uses `putTableRows` with a case revision per chunk. Chunks reserve three statements for transaction bookkeeping and obey the deployment’s `userWorkLimits.maxStatementsPerBatch` (20 on staging). Deselection keeps a `selected=0` row.
