# Native recovery adapters (checklist 16)

**Source implementation, not native acceptance.** `createNativeRecoveryAdapters(options): Promise<RestoreDeps>` lives in `src/lib/recovery/hosted/native-adapters.ts`. No runtime, route, configuration, provider resource or migration is installed by this change. Native/provider execution is **UNRUN**.

## API and trust boundary

Call the factory per authenticated request and case. `NativeRecoveryOptions` requires:

- `resources: NativeRecoveryResources`: validated `ClientResourceIdentity`, exact `boundResources: ExactDeploymentTuple`, native D1 `withSession('first-primary')`, and R2 `get/head/put`. R2 bodies must expose the native `ReadableStream`, not merely `arrayBuffer()`.
- The **genuine receiving request's** `identity` and `audit` sink. Nothing constructs a verified requester, authorizer or grant. The factory builds the real `createCloudResults` reader/assets and `createD1UserWork` on one shared first-primary session.
- `caseId`, `now`, `newId`, every `StorageBudgets` field and a valid `D1UserWorkConfig`. Source buffered-object/package-file/snapshot bounds must fit `limits.maxFileBytes`.
- All four positive safe-integer limits: `maxFiles`, `maxFileBytes`, `maxTotalBytes`, `maxManifestBytes`. File bytes cannot exceed total bytes; there is **no 8 GB/default-limit fallback**.
- `target: NativeRecoverySource | null`. The target has separately authenticated identity/audit, resources and required storage/user-work bounds.

The native binder must positively associate **actual handles** with trusted resource identities. `boundResources` is not request input or another name for requested configuration. D1/R2 request APIs cannot disclose their deployment resource IDs. The factory validates the exact tuple, then checks real `rs_storage_identity`, `identity/client.json` and `uw_binding`; those gates prove client/schema identity, **not which same-client physical database/bucket a wrapper hides**. If the parent cannot supply the trusted handle/resource association, it must leave `target: null`. This is an explicit parent hook, not a proof invented by this adapter.

## Implemented facts

- Source-review M2/M5: after `writeOnce`'s awaited preflight head, source and target object ports run the controller's full source audit/version callback **before** their final genuine receiving authority check, then immediately invoke conditional put without another source await. No overwrite or invented acknowledgement is introduced.
- Source-review M1 is fixed by checking session/grants after each awaited publication query, before returning visibility or preview metadata. Base `6486199e` failed those independent findings and is not source-approved.
- `objects` uses case/client/export-scoped private keys, R2 SHA-256 and conditional `onlyIf: { etagDoesNotMatch: '*' }` through the existing `writeOnce`. Every write receives exact bounded streamed readback. Blob keys bind the digest; manifests use R2's recorded checksum plus the controller's pinned manifest digest. No overwrite/delete/public URL exists.
- Private reads accept a trusted optional `beforeRead` callback. Binding preflight and the callback run before final genuine source/receiving authority and R2 get; callback/authority repeat before stream pulls and after awaited cancellation, before release. Reads reject wrong key/checksum/size, overrun, truncation and corrupt bytes; refused bodies are cancelled. Writes copy input before awaits. Conditional races and lost acknowledgements reconcile through exact readback; an uncertain committed write reports `exists`, never a fabricated `created`. Consequently a lost **source manifest** acknowledgement can conservatively surface as `export-exists` under the unchanged core contract.
- `previews.previewsOf` enumerates actual `rs_preview` rows joined to that case's stored results version on the same source service session (not an atomic snapshot). Identities, filename, media type and size are unchanged. Fresh authority/publication checks bracket the awaited query.
- `visibility.kind === 'current-policy'` binds the exact factory identity object, receiving client, case and resultsVersion. It checks fresh session/grants and actual `rs_publication` + stored-version ownership + `rs_version_withdrawal` via `requirePublished`. Private, unknown, withdrawn and superseded-invisible versions return false. Policy faults hold; staff kind, case preview grants and archived flags never substitute for exact publication.
- Source `versionsOf` explicitly inventories **all** case results identities, rather than the production reader's intentionally publication-only listing. A hidden identity holds the whole export; nothing is silently filtered. The final source `getCase` rechecks this inventory. Retained export verification continues to check every manifest identity through the unchanged core visibility checks.
- Package bytes, package provenance, case IDs, asset IDs and refs are not rewritten. Case/asset/package reads use genuine current reader/assets/user-work/audit implementations. Raw object ports are internal storage primitives: never expose `objects.get` as a download route; retained delivery must use the core verification/current-policy boundary.

## Legacy /1 native source HOLD; opt-in /2 interface

The existing `ExportManifest` / `VersionRecord` / `OriginalRecord` interfaces cannot represent native submission/import/correction lineage. In particular `native_import_link.submission_revision_id` and its exact submission-manifest digest are **not** `VersionInfo.input_revision_id` (the package input digest); finalized `submissions_file` path/asset mappings and native correction/audit bindings have no archive slots. Package `assets.json` alone is not that bridge.

Accordingly legacy `exportCase` still returns `recovery-unavailable` when **any** case `native_candidate` or `submissions_upload` exists (also when that schema cannot be read). Its `/1` representation and HOLD are unchanged. The parent has now accepted a separate, bounded native `/2` evidence interface: see [native-recovery-evidence.md](native-recovery-evidence.md) for the explicit policy, the case-audit entitlement hook, codec, fresh-primary batch and export/verify/non-activating restore APIs. That opt-in path is not a `/1` waiver or native/provider acceptance. No IDs or missing lineage are invented.

## Restore isolation and actual scope

A target must have distinct trusted Worker, hostname, D1 UUID/name and R2 bucket identities, distinct binding handles, matching client/caller principal, its own authenticated identity service, existing case, and successful storage/UW gates. Renaming a wrapper while sharing any resource identity is refused. Missing, unprovisioned, crossed or unauthorized targets remain null, so core restore returns unavailable/503. Same case ID is retained in the separate deployment; no case remapping or grants are created.

The unchanged restore plan binds its exact hash, target revision and manifest. `applyRestore` makes additive immutable R2 archive copies and invokes the real target D1 `snapshots.put` / `importAll(expectedRevision, preRestore, operationId)`. Existing work refuses; a competing write survives the real revision guard. Unknown user-work definitions require separate trusted provisioning: definition authority is deliberately null, not an implicit grant.

**`activated: false` means archive plus user-work staging only.** It does not attach results/package/original rows to the target, publish anything or activate a recovered client case. The target's snapshots/additive objects can remain after failure; this is not an atomic cross-D1/R2 rollback. Target read/write wrappers recheck genuine source and target authority. Recovery-local per-call D1 composition guards each user-work SELECT with genuine content authority and each snapshot/import/acknowledgement batch/run with the full controller callback followed by final receiving authority. No user-work/storage implementation, principal, role, persisted field, lock or process is added. Observation order is finite: source audit/version policy, then source content authority, then the target's separately authenticated content/write authority, then IO. External session/grant/publication changes after their respective observations can still race storage; no cross-Clerk/D1/R2 atomic revocation or distributed lock is claimed. The unclassified manifest/no-audit-hook limitation is recorded explicitly in [native-recovery-evidence.md](native-recovery-evidence.md#authority-observation-order-local-source-interface).

## Checks and parent hooks

Synthetic tests use actual migrations, real D1 grant authorizer/audit/results/user-work adapters, SQLite batch transport and faultable R2-shaped streams. They are **not Cloudflare/Clerk proof**. They exercise identity/target crossing, live grants/publication/withdrawal, races, acknowledgement loss, exact integrity/bounds, retained-export denials, non-destructive staging and actual isolated-D1 revision/snapshot/import behavior. The focused runner includes all unchanged 69 recovery tests and a forced-new-root production import-graph test. It pins `maxWorkers: 1` and inherits root `erasableSyntaxOnly`.

Run with receipt wrappers:

```sh
bun run --bun test --config tests/hosted-foundation/recovery-native-adapters/vitest.config.ts --maxWorkers=1
bun x tsc --noEmit -p tests/hosted-foundation/recovery-native-adapters/tsconfig.json
bun run --bun check:hosted-imports
```

Parent owns runtime/route/config wiring, root test registration, trusted isolated resource binding/provisioning, native evidence, and any accepted lineage interface. A second core hook is diagnostic: existing `loadExport`/restore object-port catch blocks map typed late authority refusals to `storage-unavailable`; no bytes escape, and the genuine authorizer records denial, but the recovery failure event may be `failed`, not `denied`. Preserve typed denials there rather than weakening the adapter's late rechecks. No shared core change is made here.
