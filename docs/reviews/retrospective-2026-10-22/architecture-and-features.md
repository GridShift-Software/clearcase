# Architecture and features retrospective

Review date: 22 October 2026. Scope: application architecture, representative paths through the 42-view workspace, import/activation, user work, storage, portability and avoidable cost. This replaces only the failed architecture reviewer. No implementation changes are proposed as already applied.

## Revision and evidence boundary

- Reviewed `audit/retrospective-2026-10-22` at **225b7e00578319d16383678a8d1ae6efb362a0ba**. All source line references below name that revision.
- Incoming proofs head: **a3f80d1305294a8c685a87351281eef7928c7d9c**. Its merge base with the reviewed head is the reviewed head itself. `git diff 225b7e0 a3f80d1 -- src` is empty: the incoming proof work does not fix the application findings below. Probe implementations are not production application implementations.
- Incoming guard head: **99cf56bba6afc0bf30d0dc914816ad97d1a750ae**. Its merge base with the reviewed head is **e44e12b397561e7d7ad229e8fad00753db9f00bc**. `git diff 225b7e0...99cf56b -- src` is empty. A two-dot comparison against this older branch includes application changes already on dev; those apparent removals must not be reported as new incoming regressions.
- Read repository `AGENTS.md`, the relevant development/package contracts, glossary, ADR 0004, view registry, ticket snapshots and source/tests. No parent workspace instructions were assumed. No skills were invoked; no agents were spawned.
- Ran `C:/Program Files/Git/bin/bash.exe scripts/agent-tools/doctor`: exit **1**, `agent-tools: unsupported OS 'msys'. Supported: Linux (Arch, CachyOS) with bash >= 4.4. See docs/agent-tooling.md.` No acceptance receipt or gate PASS is claimed.
- Verification is source inspection plus the small, in-memory source-function diagnostic recorded below. No builds, installs, browser acceptance runs, case data, credentials, deployment or external writes. Existing tests were read, not run. This is **not acceptance evidence** for the pinned revision.
- Linear connector reads worked through `list_issues` and `get_issue`. Relevant live reads included GRS-47, GRS-128 and GRS-133; searches covered bundle/backup/case-switch work. Search results are not proof that no duplicate ticket exists. Suggested ownership below is not a newly created ticket.

## Assessment

The local pilot has useful boundaries worth retaining: immutable results packages; separate user-work storage; explicit activation and rollback; shared register queues; fingerprint-based note/annotation anchors; generated navigation ownership; and pure view transformations separated from server access. There is no evidence here that a framework or database rewrite would improve alpha delivery.

The strongest remaining risks are **case identity and browser state scope**, followed by **operation-level durability**. The app protects individual writes well, but a case-wide workflow can still combine the wrong state or expose a partially committed operation. Fix those narrow seams before broad hosted view migration.

Severity: P1 = prioritize before normal multi-case use; P2 = bounded correctness fix before relying on the affected workflow at scale; P3 = maintainability/performance improvement without a demonstrated acceptance-budget breach.

## Findings

### ARCH-01 — P1: PDF builder state follows the browser session into another case

**Evidence.** `src/lib/views/bundles/builder.svelte.ts:4–9` defines one module-global builder, PDF-document map and blob map. `Builder.svelte:16` receives no case identity; its only explicit builder reset is the user's Clear operation at lines 44–50. Build completion writes to the same global output at lines 68–91. Save at lines 110–127 sends that output through `postAction('save', ...)`; `src/lib/views/bundles/post.ts:12` posts to the current page's relative action. `src/routes/v/[vid]/bundles/court_bundle_tab/+page.server.ts:94–106` derives the destination case from the current URL and saves the supplied bundle there. Neither the source state nor the save request identifies the originating case.

**Trigger and impact.** In case A, add a synthetic PDF and build an output. Use All cases/Cases to open case B without a hard reload, then open its builder. The shared module still holds A's PDFs, selections and output; Save now associates the output's metadata with B. The PDF blob itself remains browser-local, but it can be opened/downloaded under B's workspace and its metadata can be stored in B. Starting another assembly with B's header can also combine B's heading with A's selected evidence. An assembly finishing after navigation has the same ownership ambiguity.

This is a source-derived browser-path finding, not a reproduced browser acceptance result. SvelteKit documents preservation of state across navigation; component disposal alone would not reset this imported module's state. See the [official state-management documentation](https://svelte.dev/docs/kit/state-management).

**Smallest fix.** Give each builder session an explicit case identity. Either keep sessions keyed by case, or require an explicit discard when changing case and clear/revoke its PDFs and object URLs. Pin async assembly/save completion to the originating session; submit to its captured action URL and refuse a mismatched destination. Preserve intentional navigation-away-and-back behavior within the same case.

**Validation needed.** A → B → A using client navigation, with distinguishable synthetic PDFs; save in B must never save A's output. Repeat while assembly and save are in flight, then test same-case navigation and result-version changes. Assert output bytes/header, saved case ID and object-URL lifecycle, not just an empty screen.

**Ownership/status/confidence.** New concrete local defect in GRS-19's feature; coordinate its fix with [GRS-133](https://linear.app/vaper/issue/GRS-133/migrate-litigation-and-existing-bundle-workspaces-to-hosted-contracts). GRS-128 already plans durable bundle inputs/history, but persistence is a separate issue and does not justify cross-case transient state. Neither incoming head changes these paths. **High confidence** in the missing ownership boundary; browser reproduction remains required.

### ARCH-02 — P1: click-import silently treats unrelated same-named folders as one case

**Evidence.** `src/lib/local-case/case-pack.server.ts:104–107` derives identity by lowercasing, folding accents, replacing characters, truncating to 64 characters and falling back to `case`. At lines 227–230, only `path.basename(caseFolder)` supplies that identity. The operator's `caseLabel` affects the label, not the ID. `service.server.ts:285–290` checks a different case root only if the **same resultsVersion** already exists. Distinct packages with the same derived case ID pass that comparison. `service.server.ts:163–172` groups the case list by case ID; `user-work.server.ts:145–159` reads/writes register rows by that same ID; `store.server.ts:156–171` activates by case ID.

**Trigger and impact.** Import `/client-a/Pack` and `/client-b/Pack`, with different synthetic contents, through the click workflow. Both become case `pack`, even if the user gives them different case names. Different content gives different resultsVersions, so the existing-version folder check does not stop the second import. The UI groups the packages as versions of one case; activating B replaces A's active pointer, and case-scoped registers/overlays belong to the same namespace. The same risk exists for distinct names that normalize/truncate identically. This is an application identity defect, separate from the converter-field collision review.

**Diagnostic actually executed.** A Node stdin script read the committed `caseIdFrom` function body and its committed `CASE_ID` pattern, evaluated only that pure function, and printed:

```text
Pack / pack                          -> pack / pack       (collision)
Caf\u00e9 / Cafe                     -> cafe / cafe       (collision)
64 x 'a' + '-one' / 64 x 'a' + '-two' -> 64 x 'a' each     (collision)
```

Exit 0; no files/databases created. This demonstrates the lossy identity function only. Import, activation and user-work effects are established by the source chain above and still need an end-to-end synthetic regression.

**Smallest fix.** Before accepting a click import, detect that its proposed case ID is already attached to another source root and refuse with an actionable explanation unless the user explicitly selects an existing-case update. Give new cases a stable unique identity independent of their display label. Do not silently change IDs of already imported cases. A collision refusal is a small immediate safeguard; the full create/update/relink flow belongs to the existing design owner.

**Validation needed.** Two different parent folders with identical basenames and distinct packages, accent/case/truncation pairs, and two different display labels. Prove separate active pointers and register rows, and that legitimate repeat import/update of the same case retains identity and user work.

**Ownership/status/confidence.** GRS-70 click-import path; coordinate with [GRS-47](https://linear.app/vaper/issue/GRS-47/provide-per-case-local-import-and-update-with-user-chosen-source-folders), which remains Backlog and explicitly owns create/update identity/relink design questions. The missing full lifecycle is planned work; **silent merging in the already available click path is the narrower defect**. Neither incoming head fixes it. **High confidence**.

### ARCH-03 — P2: a rescan is many committed writes, so interruption leaves mixed scan generations

**Evidence.** `src/lib/local-case/rescan/rescan.server.ts:127–154` computes a complete comparison, then awaits one `putTableRow` for every changed row (144–146), individual deletes (148), and finally writes the run's counts/issued refs/verdict (152). `user-work.server.ts:227–253` gives each put its own transaction; deletes do likewise at 260–272. `db.server.ts:226–249` commits each transaction independently. The `inTurn` queue at rescan line 117 serializes cooperating writers but is not a database transaction. `lastRun` at 59–67 independently reads the previous run summary.

**Trigger and impact.** After one completed scan, change/add several files, start another scan and interrupt after the first row commit but before the run summary commits, or make a later write fail. On restart, some `rescan_file` rows reflect the new scan while others and `rescan_run` reflect the previous scan. The overview uses the old completed verdict (`overview-widgets.server.ts:17–25`, `FreshnessWidget.svelte:9`), while additions/readers can consume the partial rows. Clear additions has the same per-row interruption shape at rescan lines 158–168. The summary includes its old timestamp, so this is an incoherent snapshot, not a claim that the UI necessarily labels the failed scan successful.

The same loop also imposes O(changed rows) transaction commits and backup rescheduling. With the configured rollback journal and `synchronous=FULL`, this is avoidable disk work; no latency estimate or measured budget failure is asserted.

**Smallest fix.** Finish walking/hashing before taking the write transaction, then atomically apply the row upserts, removals and run summary in one synchronous transaction under the existing case queue. Expose a narrow batch operation through user work; do not wrap existing async methods in `Storage.tx`, whose callback is synchronous. Make clear-additions atomic as well, or deliberately stage and publish a complete scan generation.

**Validation needed.** Inject failure after the first mutation and just before summary publication; assert the complete previous snapshot remains. Add process-interruption coverage and restart readback on Linux. Measure a synthetic scan with many additions and assert one operation-level commit, complete counts and stable issued refs. Existing `tests/system/rescan.test.ts` covers comparison/repeat behavior; inspected tests do not establish rollback of this multi-write sequence.

**Ownership/status/confidence.** GRS-20; new operation-level finding, distinct from GRS-54's already implemented restore queue. No fix in either incoming head. **High confidence** in partial persistence; failure injection and performance measurement remain outstanding.

### ARCH-04 — P2: the app can successfully export a backup that its own restore always rejects

**Evidence.** `src/lib/user-work/backup/backup.server.ts:11` caps accepted backup text at 64 MiB, enforced by `checkBackup` at line 70. `src/lib/views/system/backup.server.ts:49–61` independently refuses oversized uploads and server files. However, `createBackup` at backup lines 32–50 and `backupFile` at system lines 42–45 serialize all selected user work without an output-size guard. Pre-restore JSON copies at backup line 111 use the same unrestricted serialization. The underlying store limits individual register JSON fields to 64 KiB (`user-work.server.ts:33`), not the total rows/bytes of a case.

**Trigger and impact.** Accumulate enough legal user work to exceed the restore cap, then download Backup / Restore's JSON. The download is produced as a backup, but both normal restore input paths reject it before parsing. For scale, 1,100 entries with 64,000 ASCII characters each contain 70,400,000 text bytes before metadata/pretty-printing, exceeding 67,108,864. This arithmetic was checked in memory; that database/UI population was not executed. The separate automatic SQLite backups remain available, so this finding does not assert loss of every recovery route.

**Smallest fix.** Make the serialized export and restore contract symmetric. Immediately check the exact UTF-8 byte length of the delivered representation and give a clear refusal/recovery alternative if it cannot be restored. For supported larger cases, implement a bounded chunked/streaming format rather than increasing the restore allocation limit without measurements. Do not market an over-limit JSON artifact as restorable.

**Validation needed.** Round-trip real serializer output just below, exactly at and above the limit, including multibyte text and indentation overhead. Exercise both upload and typed-path restore. Ensure the UI never reports a usable backup when its own restore will reject it, and that SQLite recovery remains documented.

**Ownership/status/confidence.** GRS-20 local backup; coordinate future format policy with GRS-118. That hosted recovery ticket does not fix today's local export mismatch. Neither incoming head changes these functions. **High confidence**, threshold trigger not exercised through the app.

## Low-hanging efficiency and maintenance work

### ARCH-05 — P3: narrow backup reads before materializing unrelated cases

`createBackup` calls `userWork.exportAll()` before filtering by case (`backup.server.ts:35–38`). `exportAll` selects every row in each table and validates it against both the current and fresh-store shapes (`user-work.server.ts:276–297`). Even opening the backup page repeats that full export just to obtain table counts (`views/system/backup.server.ts:22–34`). Thus backing up a small case costs memory/work proportional to all cases, and unrelated data is materialized unnecessarily. The pre-restore copy repeats this path.

Small change: add a case-scoped exporter that pushes `WHERE case_id = ?` into case-table reads, keeps the documented store-scoped-table behavior explicit, and preserves excluded-table diagnostics. Use count queries for the page summary where possible. Validate output equivalence on two synthetic cases, excluded tables, store-scoped rows and fresh-store restore. Measure heap/time with a large unrelated case. **High confidence in redundant work; no measured slowdown or cross-case data leak claimed.** GRS-20 ownership; the hosted contract already has `exportAll({caseId})`, so carry the scope into implementation rather than porting this local pattern.

### ARCH-06 — P3: avoid rebuilding the entire document projection before checking evidence caches

`documents.server.ts:121–130` calls `store.projectionRows(...).documents`; that helper also selects all assets and seeds (`store.server.ts:123–128`), which this caller discards. `documentRow` parses the complete chronology JSON to locate one ref (`documents.server.ts:136–141`). Once any rescan provider is registered, `listJson` always takes `collect`, including for cases with no additions (`documents.server.ts:169–176`). `evidenceRows`/`searchRowsOf` call it **before** their cache lookup (`views/evidence/rows.server.ts:10–15,26–33`), and a search miss builds document rows again.

Small change: split a document-only projection query from the integrity-verification projection, and derive/cache the base list keyed by verified read-model digest. Keep provider revision/failure state in the combined key and check it before materializing unchanged imported rows. Do not cache only by resultsVersion if provider rows or integrity state can change. Validate changed/cleared/restored rescan additions, provider failures and recovery/repair; measure the existing navigation/search budgets on both corpus sizes. **High confidence in extra queries/parsing; no evidence that 1,689 or 2,131 documents currently breach a budget.** GRS-12/14/20, with GRS-131 migration coordination.

### Register abstractions: preserve the shared lock, reduce the number of write policies

There are several overlapping layers: `local-case/registers.server.ts` provides queued register operations, `user-work/registers.server.ts` supplies a separate generic-register adapter, filings implements its own queued editing, and bundles implements another guarded-write helper. They sensibly share `inTurn`, but row-version semantics differ: local register `rowVersion` hashes fields (`local-case/registers.server.ts:38`), while generic register `versionOf` hashes fields, anchor and updatedAt (`user-work/registers.server.ts:16`). Deletes and retry identifiers also vary by owner.

This is a maintenance risk, not proof that every variation is wrong. Establish one documented mutation contract for create idempotency, expected version, missing rows, delete confirmation, partial batches and saved-but-refresh-failed outcomes. Keep view-specific field parsing separate. Refactor a second consumer only when proving equivalent behavior; do not build a universal form engine. Hosted `contracts.ts` already models operation IDs, expected versions and case revisions. Use that existing destination, with adapter/owner tests, instead of inventing a competing abstraction.

## Representative flow coverage and positives

- **Navigation and 42-view inventory.** Read the generated registry: all 42 entries are available, with seven categories, explicit routes and owner tickets. The drift check gives a practical completeness contract. This review does not claim to have driven all 42 views. Root/version layouts, per-version navigation and candidate banners provide clear boundaries; URL/query preservation already includes case/version identity, unlike ARCH-01's builder.
- **Import → report → preview → activation.** Traced click-import and package-import actions, package preparation, storage/rejection paths and `LocalCase.#activateNow`. Activation revalidates candidate bytes and originals, compares read-model digest, binds warning acknowledgements and writes pointer/log together. Same-content import, immutable manifest conflict, repair and rollback are explicit. Preserve these checks; ARCH-02 belongs before them at case selection/identity.
- **Overview → chronology → document → original.** Inspected layout verification, document-row/provider resolution, evidence search and the document loader's original/attachment link generation. Imported rows win provider collisions; failures/drop reasons are explicit. The originals-serving boundary is separate from narrative rendering. A focused query/cache improvement can retain these contracts.
- **Analysis and quantum.** Inspected dataset access, citation resolution, analysis feature flag, quantum data/payment wiring and shared user-work writes. Calculations, converter fidelity and data collisions are assigned to another reviewer; no independent correctness conclusion on those computations is claimed here.
- **Registers and litigation.** Inspected the generic register page/server adapter, anchor re-resolution, queue/CAS operations, litigation entry state and status updates. Failed edits generally retain typed input, and stale/gone states are explicit. Results seeds and user overlays remain distinct. Preserve these behaviors during consolidation and migration.
- **Bundles.** Inspected builder assembly/save state, header conflict checking, mark/custom stores and source-link resolution. The separation between browser-only PDF bytes and saved metadata is real and documented; durable reopening is planned work. The unscoped session state is a narrower present defect.
- **System.** Inspected rescan comparison/storage/provider, freshness widget, backup serialization and restore. Restore takes the case's exclusive queue, creates a pre-restore copy and invokes transactional `importAll`; it rejects wrong-case rows and does not import warning trust. These are strong choices. They do not make the separate rescan sequence atomic or guarantee export-size symmetry.
- **Storage and integrity.** Explicit journaling/synchronous settings, instance locking, checked store-file identity, cached verification invalidation on external commits and startup recovery are more valuable than replacing SQLite. `Storage.tx`'s synchronous callback should remain explicit. Avoid duplicating these mechanisms in feature loaders.

## Portability, planned work and incoming fixes

The local runtime is intentionally Linux-specific: `LocalCase.startup` checks `/proc/self/fd` (`service.server.ts:86`), the instance lock uses Linux process start time (`db.server.ts:110–113`), and the verification workflow uses namespaces and Linux tooling. Folder-picker WSL drive shortcuts are not native Windows support. The failed doctor here is an environment limitation, not proof that the product regressed or a request to replace safe file-opening with weaker cross-platform code. If native Windows local delivery becomes a requirement, scope it separately and prove equivalent original integrity and process ownership.

Hosted isolation, identity, D1/R2 adapters and case-independent lifecycle are explicitly planned. The request-scoped async contracts are a useful migration seam; synchronous local `app()` callers are not yet hosted-safe. GRS-131/132/133/134 own view migration, GRS-117 owns durable hosted user work, GRS-118 owns hosted recovery/export, and GRS-128 owns durable bundle versions. Those missing production features are **planned work, not newly discovered defects**. The hosted results-import endpoint remains unverified; neither upload APIs nor incoming probe routes prove it.

Current dev already includes release fixes that an older branch's two-dot diff can make appear missing: builder reload handling GRS-160, delete confirmations GRS-175, calendar handling GRS-174, and converter collision fixes GRS-170/171. Do not reopen them solely from that comparison. GRS-181 is an existing follow-up for no-JavaScript Delete retaining typed Add input and other release-fix edges; those are not claimed as new findings here. This review does not declare the incoming proof or guard PR accepted and did not monitor either PR.

## Priorities and handoff

1. **Resolve ARCH-01 and ARCH-02 before normal multi-case use.** Both can associate evidence/user work with the wrong case. Add two-case interaction/import tests, not only single-case feature coverage. Coordinate ARCH-02 with the data reviewer to avoid duplicate reporting, while keeping its click-import identity cause distinct from converter key collisions.
2. **Make rescan publication atomic (ARCH-03).** This improves interruption behavior and removes repeated commit cost with one bounded change.
3. **Make backup output restorable by construction (ARCH-04), then scope its reads (ARCH-05).** Preserve the existing safe restore and SQLite fallback.
4. **Remove demonstrably redundant projection work (ARCH-06) when touching the reader.** Measure before widening optimization scope. Consolidate write policies alongside their assigned migration owners, without a speculative rewrite.

All runtime validations listed above are outstanding at the exact candidate SHA. The parent owns prioritization, implementation, final synthesis and any tracker changes. Report: `docs/reviews/retrospective-2026-10-22/architecture-and-features.md`.
