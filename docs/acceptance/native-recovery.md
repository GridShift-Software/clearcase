# Native complete case export and recovery primitives (native24)

**PREPARED / UNVERIFIED.** Library code and synthetic unit tests only. No route, real object store, D1, Worker, browser, provider or hosted run exercised it. It is not a gate PASS or native acceptance, and it changes no permission, retention or shared runtime file.

Code: `src/lib/recovery/hosted/`; tests: `tests/hosted-foundation/recovery/` (focused runner `vitest.config.ts` there; its include REPLACES the root list).

## What it does

- `exportCase(deps, {caseId, exportId, includeUserWork})` writes one case's recovery export into an injected **durable private object port**: every original's actual bytes, previews of the published version, every results package file byte-for-byte with its `VersionInfo` provenance (input revision, manifest/diagnostics/read-model digests, validator version, warning fingerprints), the publication and active-version identity, the case revision and, **only when explicitly selected**, independent user work (notes, registers, anchors) as its own blob (glossary: notes absent unless selected). Embedded originals are recorded explicitly with no invented hash.
- Authority comes first: unauthenticated, revoked, foreign or ungranted callers are refused before any byte, store read or write (a denial appends a scoped audit event). The audit record for the read is required before the first byte; an audit fault refuses. Authority is rechecked before the manifest commits.
- Bytes are hashed against the asset's own metadata and listing. A missing or changed original, an unverifiable package, a case that moved mid-export or a bound breach (declared sizes, checked before reading) fails the export; there is no "partial but labelled complete".
- Blobs are written, read back, then the manifest is written **last** with put-if-absent. No manifest means no export; a repeated export id is refused (`export-exists`) and never overwrites. The manifest is canonical JSON, allow-listed (no session id, token or credential; a session id appearing in it refuses).
- `verifyExport` re-reads the stored export: pinned manifest SHA-256, strict manifest shape, accounting recomputed from entries, every blob's size and SHA-256. Missing = `export-incomplete`, differing = `export-corrupt`, wrong pin = `manifest-mismatch`, another client's manifest = `foreign-input` before any blob read.
- `planRestore` is read-only. `applyRestore` needs the exact plan hash (it includes manifest digest and the target revision), requires an **isolated target** (isolation id different from the live instance, distinct object and user-work ports, same client, empty user work), refuses a differing already-staged object before any write, takes the **pre-restore snapshot** first, stages additively (put-if-absent, resumable after a restart), imports user work through `importAll` behind the expected-revision guard, and returns per-category accounting plus invariants (objects accounted and verified, user-work rows accounted, nothing deleted or replaced). It never activates, deletes, applies retention or touches the live case. `report.ok` must be checked: a failed invariant after a committed import is reported, not thrown.
- Required-null port (or a `test-standin` port under the `production` profile) is `recovery-unavailable` (503, retryable) before any authority check. There is no in-memory fallback in `src/`.

## Integration handoffs (not done here)

1. Real adapters: R2-backed `PrivateObjectPort` (client-scoped prefix, conditional put); a `PreviewCatalog` over `rs_preview` (`AssetsAccess` has no preview listing); an isolated restore target (separate D1/R2 scope and its `AsyncUserWork`, `stateRevision`).
2. `CaseOperation` has no export/restore operation. This uses `read`, `read-original`, `read-preview` and `write-user-work` on the source case. A dedicated, separately granted `case.export`/`case.restore` (like `case.upload-originals`) needs GRS-114 policy work and was not changed.
3. `versionsOf` is trusted to hide candidates from callers who may not see them; the export includes whatever it returns.
4. Staged restore is not activation: pointer swap, publication restore and audit-chain placement belong to the publication owner.
5. Root `vitest.config.ts` include for `tests/hosted-foundation/recovery/**/*.test.ts` (coordinator-owned).
6. Untested against real boundaries: R2/D1 durability and conditional-put semantics, Worker memory/CPU limits for large exports (the port is whole-object, not streaming), restart in a real process, hosted authorizer, audit durability.
