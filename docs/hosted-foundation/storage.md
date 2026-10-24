# Hosted results storage and protected originals (GRS-115)

The hosted `CaseReader` and `AssetsAccess` over one client's D1 database and private R2 bucket, the D1 migration, and the storage-level helpers that the client upload controller (GRS-28) and the operator candidate import controller (GRS-30) call. Words follow [GLOSSARY.md](../../GLOSSARY.md). The layout follows the GRS-109 probe ([storage proof](../acceptance/hosting/storage.md)); the differences are listed below.

**Status: PREPARED, UNVERIFIED.** The unit tests in `tests/hosted-foundation/storage/` run the adapters against test doubles (D1 over `node:sqlite` with the real migration, R2 in memory). They are not evidence of Cloudflare D1 or R2 behaviour, limits or latency, nor of local workerd. Nothing here is composed into `hosted/services.ts` yet, so production still answers 503.

## Modules

| Module | Exports |
| --- | --- |
| `src/lib/storage/cloud/migrations/0001_rs_results_storage.sql` | The `rs_` tables. Applied by the deployment (`wrangler d1 migrations apply`), never by the Worker. |
| `src/lib/storage/cloud/bindings.ts` | `cloudBindings(env): CloudBindings \| null` (`DB` with `prepare`/`batch`, `BUCKET` with `head`/`get`/`put`). |
| `src/lib/storage/cloud/budgets.ts` | `storageBudgets(value): StorageBudgets \| null`. All seven bounds are required; there are no defaults. |
| `src/lib/results/hosted/index.ts` | `createCloudResults({ bindings, clientId, budgets, identity, record, stateRevision }): { store: CaseReader; assets: AssetsAccess }` |
| `src/lib/storage/cloud/intake.ts` | `createOriginalIntake({ bindings, clientId, budgets, now }): { declare, put, finalize }` |
| `src/lib/storage/cloud/staging.ts` | `createResultsStaging({ bindings, clientId, budgets, now }): { stage }` |

## Rules

- **Client.** `clientId` comes from trusted deployment configuration only. Before any read or write, the storage gate checks that `rs_storage_identity` and the bucket's `identity/client.json` both name it. A missing, malformed or other-client identity refuses everything with `storage-unavailable` or `asset-unavailable`, and never names the other client. A missing binding, client id or budget refuses in the same way.
- **Results.** A version is `staging` until one guarded batch checks every count and stores it. A stored version is immutable. Clients reach it only as the exact published version of its case. A candidate (stored but not published), a staging version and a withdrawn version are refused with `forbidden`. A Keep mark (`keep = 1`) never changes that. A withdrawal binds even if a stale publication pointer still names the version. Version reads authorize, check the publication, and then authorize and check it again before they return.
- **Originals.** Originals are case-level inputs and are reachable through the case grant (`read-original`), with or without a publication. Each original is content-addressed (`orig/<sha256>`) and written once: matching bytes are a no-op, and any other bytes are a conflict, never an overwrite or a delete. An asset id binds to exactly one original. Every delivery reads the whole object, rejects a size mismatch before downloading, hashes it, authorizes again and records the delivery before any byte leaves. A missing object answers `missing-original` and a changed one `changed-original`, each recorded as `failed`. One `bytes=` range returns 206 from the verified bytes. Several ranges, a range past the end or a backwards range return 416 with no body, and HEAD has no body. Every response is `attachment`, `nosniff`, `private, no-store` and `sandbox; default-src 'none'`, so original content never runs with the app's privileges.
- **Previews.** `preview/<version>/<sha256>` objects with `rs_preview` rows are reachable only while their exact version is published and not withdrawn. Nothing writes previews yet.
- **Keys.** Object keys are built only from validated digests (`orig/`, `pkg/<version hex>/<sha256>`, `preview/<version hex>/<sha256>`), never from a filename, a package path or request text.
- **Import staging.** `stage` checks the budgets, verifies the exact package bytes with `verifyCandidateBytes`, requires the manifest's `case.id` to be the target case, and checks that the projection matches the package: counts, one document per list entry, the same order, and JSON values. It then writes the version row, the package-file rows, the objects (write-once), and the document, asset and seed rows in guarded batches of at most `maxRowsPerBatch`. A failed attempt stays `staging` and is never served. A retry deletes the old attempt's rows in the same batch that starts a new attempt. `stage` never publishes.
- **Upload intake.** `declare` records the upload before any byte is written, so an object never exists without a row that traces it. `put` refuses bytes that do not match the declaration. `finalize` hashes the stored object whole and binds the original in one guarded batch. Repeated calls are idempotent per `operationId`.

## Differences from the GRS-109 layout

- The chronology list is stored per document in D1 (`rs_document.list_json`), not as `rm/<version>/chronology.json` in R2. A document page and the list cost one D1 statement each. The list's D1 read size at v5 scale (about 1.5 MB) is not measured.
- Package-file keys are content-addressed within their version, not path-addressed.
- Objects larger than `maxBufferedObjectBytes` are refused (`asset-unavailable`), not served through the probe's two-read stream. A larger original needs that streaming path, which is not implemented here.
- The storage gate is cached per `createCloudResults` call, not per isolate. If the composition creates it per request, the gate costs one D1 statement and one R2 GET per request.

## Not done here

- Publication and withdrawal writes (GRS-31), user-work revision and storage (GRS-117), the audit sink (GRS-116), the upload and import routes and their authorization (GRS-28, GRS-30), and preview generation.
- A reaper for `declared` uploads whose object never finalized, and for objects of abandoned `staging` attempts.
- Real D1/R2/workerd legs, numeric budgets and EU placement (see [What stays HOLD](../acceptance/hosting/storage.md#what-stays-hold)).
