# Native recovery evidence /2 — local source interface

**Implemented source interface; native acceptance UNRUN.** The parent accepted this envelope on 25 October 2026. It is not a waiver of the legacy native-source export HOLD. No runtime service, route, configuration, schema, target or provider resource is installed here. Base `6486199e` failed independent source review (M1/M2); it is not source-approved.

## Parent configuration and entry points

`createNativeRecoveryAdapters(options): Promise<RestoreDeps>` retains all existing resource, identity, storage, user-work, file and manifest requirements. It additionally accepts:

```ts
nativeEvidence?: {
  maxLineageRows: number;
  maxLineageBytes: number;
  visibility?: VersionVisibilityPort;
} | null
```

Both lineage limits must be explicit positive safe integers smaller than `Number.MAX_SAFE_INTEGER`; there are no defaults. All four existing limits remain mandatory: `maxFiles`, `maxFileBytes`, `maxTotalBytes`, `maxManifestBytes`. The factory freezes its copied policy. Missing native policy leaves `deps.nativeEvidence === null` and `/2` unavailable. Malformed policy, missing batch support or unavailable schemas refuse; there is no alternating-read fallback.

Omitted `visibility` retains **current-publication-only** policy. It does not authorize private, withdrawn or superseded-invisible identities, even for staff. A complete correction archive includes its parent version and therefore still holds under that default when the parent is invisible. Trusted parent composition may supply an exact live version-entitlement `VersionVisibilityPort` (`kind: 'current-policy'`), bound to the genuine request/client/case/version. It must check the real current operator/grant policy, stored ownership and withdrawal; neither staff kind, archived flags nor a case-level preview grant suffices. No operator policy is invented by this library. A configured null/malformed policy port refuses rather than falling back.

Import the new APIs directly from their owned modules (the legacy barrel is unchanged):

- `export.ts`: `exportNativeCase(deps, { caseId, exportId, includeUserWork }): Promise<NativeExportResult>`.
- `native-evidence.ts`: `verifyNativeExport(deps, { caseId, exportId, expectedManifestSha256 })`; `parseNativeManifest(bytes, NativeArchiveLimits)` is the strict standalone codec.
- `restore.ts`: `planNativeRestore(deps, verifyRequest)` and `applyNativeRestore(deps, { ...verifyRequest, confirmedPlanSha256, operationId })`.

`exportCase`, `verifyExport`, `parseManifest`, `planRestore` and `applyRestore` retain `/1` format and selection behavior (with the reviewed late-authority write fix applied to both generations). In particular, `exportCase` still refuses native candidates/submissions even when `/2` policy is configured. Parent routes must deliberately select the new APIs; unknown formats never fall through as `/1`.

## Exact envelope

`NativeExportManifest.format` is `clearcase.recovery-export/2`. It retains the explicit case/client/export identity, creator attribution, selection, originals, previews, package files, optional user-work blob and accounting of `/1`. It replaces `/1`'s source revision field with these component observations:

- `source.d1: { kind: 'primary-d1-batch', startedAt, completedAt }`.
- `source.userWork: { revision, observedAt }`: **only** the genuine user-work revision. When work is selected, it brackets its export; it is not a whole-case revision.
- `source.r2: { startedAt, completedAt, atomicWithD1: false }`; each reference retains its actual object version and ETag as observations, not as integrity substitutes.
- `source.publication` and `source.activeVersion` are projections of the captured publication/withdrawal rows, not a means of inferring candidate or submission lineage.

`evidence` is `{ format: 'clearcase.native-evidence/1', tables, rows, bytes, sha256 }`. `bytes` is UTF-8 length of canonical `tables`; `sha256` covers those exact canonical bytes. The pinned outer manifest digest covers evidence, references, all observations and all existing categories. Canonical encoding, duplicate JSON keys, exact key sets, finite numbers, supported formats, scoped rows, unique keys, foreign keys and category accounting are checked, not merely asserted by TypeScript.

`references[]` binds `{ kind, resultsVersion, assetId, path, objectKey, sha256, size, blob, objectVersion, etag }` to the exact captured package/original/preview rows. Keys must equal the existing `orig/<sha>`, `pkg/<version-hex>/<sha>` or `preview/<version-hex>/<sha>` scheme. Hash/size-covered immutable bytes must all be present. The archive never uses a supplied path as an R2 key or an executable path.

### Persisted row allowlist

The codec has an exact column allowlist over these actual migrations, not a generic SQL dump:

- `rs_case`, `rs_results_version` (identity, stored validation/provenance/counts), `rs_package_file`, `rs_preview`, `rs_publication`, `rs_version_withdrawal`, `rs_case_original`, `rs_original`, `rs_original_upload`.
- `submissions_upload`, `submissions_revision`, `submissions_file`: finalized state, persisted revision/operation/sequence/reserve timestamp, exact NFC path and persisted NFKC collision key, original asset binding, byte size and digest.
- `native_import_attempt`, `native_candidate`, `native_import_link`, `native_candidate_supersession`, `native_correction_change`: actual IDs, request/link digests, exact results/input/submission identities, coverage, operators, correction reason/time and before/after replacement-file facts. The correction ledger records replacement payloads, not an invented manifest-change row; parent/new package manifest digests are retained separately.
- `native_candidate_audit_intent`, `native_candidate_audit_settlement`, `native_audit_events`: exact candidate/event identity, settlement state and original stored digest plus the archival projection below.

The authoritative submission representation in this schema is immutable rows, not an R2 manifest object. Its canonical `canonicalText` bytes (including the persisted reserve-time `finalized_at`) are computed exactly as the existing `submissionSnapshotReader` does and checked against the stored link's `submission_manifest_sha256`. Finalization requires the upload's actual `finalized` state. `input_revision_id` is never substituted for `submission_revision_id`; a missing revision/link/candidate/file refuses instead of being reconstructed.

The source reader opens a **fresh** `withSession('first-primary')` for every capture. Its first IO is one atomic D1 batch: 20 fixed aggregate queries plus 20 fixed payload queries. Gates and authorization use the ordinary source services, not this fresh session. Each payload query suppresses over-budget table bodies in SQL; raw aggregate row/byte totals enforce the global lineage limits before any payload is interpreted. The fixed table count bounds transient transport. Malformed/incomplete/unsuccessful batch responses refuse. Real D1 atomicity remains a provider acceptance obligation, not something the SQLite transport proves.

### Historical audit, never authority

Raw `event_json`/`canonical` audit bodies are verified at the source against their original digests, then replaced with `archival_event`. Verified-person history becomes `{ kind: 'historical', issuer, subject, principalKind, sessionSha256 }`; anonymous/system history has distinct `historical-anonymous` / `historical-system` shapes. No session ID, credential, `Identity`, verified requester or grant is transported or constructed. Original digest columns remain evidence of the source record, **not** a claim that redacted bytes hash to the original. The outer/evidence digests seal the archival projection. Candidate intent, event ID, action, operator, version, time and any settlement/logged event must agree.

## Export and restore boundaries

Export verifies actual package/input identity hashes, package manifest digest and complete file set; coverage is checked against actual `assets.json` bytes and the finalized submission/original bindings. Every referenced R2 body is bounded, fully hashed and cancelled on refusal. All archive blobs are immutable and read back before the outer manifest is conditionally written/read back. Late current authority is checked before writes and after final awaited audit work. A lost acknowledgement can leave additive data or a complete manifest while returning uncertainty/`export-exists`; a retry is never manufactured into success.

Restore verifies the pinned complete `/2` envelope and every blob before planning or target mutation. It stages the **exact sealed `/2` bytes**, with blobs before the seal, into the existing genuinely separate target contract and imports only selected user work through the real snapshot/expected-revision APIs. Native rows are archival data in R2, never SQL instructions: no results/submission attachment, activation, publication, identity creation, grant resurrection, overwrite or deletion. `activated: false` remains literal. A racing target writer survives; failed/uncertain attempts may leave a pre-restore snapshot/additive objects, not a cross-D1/R2 rollback.

Trusted binder-to-handle association, separate source/receiving authentication and genuine target isolation remain the parent's obligations in [recovery-native-adapters.md](recovery-native-adapters.md). There is no cross-provider lock, global snapshot or atomic revocation guarantee.

## Source-review fixes and evidence scope

M1: each awaited publication read is followed by fresh session/grant authority before visibility or preview metadata returns; custom native policy IO is bracketed too. M2: the private object adapter interposes a fresh authority check at the actual conditional `put`, **after** `writeOnce`'s awaited preflight `head`; source and target writes use that same guarded boundary. `PrivateObjectPort.putIfAbsent` additionally accepts the trusted controller's optional `beforeCommit(): Promise<void>` hook, executed after preflight and before conditional put. Both legacy and native export/restore controllers pass their full exact-version recheck through it, so revoking publication/operator entitlement during head also prevents new writes. It is a controller capability, never request input; other object-port implementations must honor it before mutation. Conditional races, exact readback and lost-ack reconciliation remain intact. The new adverse tests cover session and explicit-grant revocation, including target writes.

Focused tests use actual synthetic schemas, intake, native import/correction/staging repositories, case authorizer, audit and user-work adapters over explicitly identified SQLite/D1-batch and streamed R2 transports. They are not provider acceptance or an auth-tenant proof. All 110 pre-existing tests remain unchanged. Root/private types, static production graphs and receipts are local checks only. **Native bindings, actual exports/restores, provider/auth acceptance, browser, workerd, full build/suites, Worker/timer actions and target provisioning remain UNRUN.**
