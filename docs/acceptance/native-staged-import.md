# Chunked, resumable results import (U15)

Local synthetic evidence only: node:sqlite stand-ins for D1, an in-memory R2, a recording stager and the real route modules. Not workerd, not deployed, not a provider or browser result. Migration 0006 is staged by `deploy/native-alpha/runtime-migration.ts` and has been applied to no D1.

## Why

The one-request import (`POST /operator/results/[caseId]/imports`) carries the whole package as UTF-8 text in one JSON body, so it cannot carry a PDF preview, and its limits (64 files, 8 MiB, 2 MiB per file in the live policy; 1,024 files in the schema) stop a v5-sized export (1,689 documents, previews, extracted attachments) before it starts. Workers Paid removes the CPU limit (`rx-cpu-probe.md`: about 0.5 s for a v5-sized validation). The limits that remain are wall time, subrequests and memory per request, so the work is split into bounded requests.

## Protocol

The routes sit under `/operator/results/[caseId]/imports/staged` and take the one-request import's authority: verified staff, own client, the `operate` capability, decided before any body byte is read; every write is fenced on the live session and the grant as SQL.

| Step | Request | Does |
| --- | --- | --- |
| open | `POST .../staged` `{operationId, submissionRevisionId, manifest}` (manifest.json as text) | Checks the manifest alone: strict JSON, committed schema, recomputed `inputRevision.id` and `resultsVersion`, case, file, byte and batch budgets. Stores the manifest object, then the session row. |
| batch | `POST .../staged/[operationId]/files` `{files: {path: base64}}` | Checks every file against the manifest by size and SHA-256 first; one bad file refuses the whole batch and writes nothing. Stores the new objects in R2 (content-addressed per client and case), then their rows in D1. Files already accepted are left alone. |
| status | `GET .../staged/[operationId]` | Progress, the first 512 missing paths, `candidateId` once linked. |
| complete | `POST .../staged/[operationId]/complete` `{}` | Refuses `incomplete` while any file is missing. Otherwise runs bounded **steps** of the stepped stager (below) and answers `202 {kind: "staging", phase, steps, done, total}` until the last, then the same attempt claim, coverage and link as the one-request import. Call it again until it answers something else. A repeat after the link answers the linked candidate without reading a file. |
| sweep | `POST .../staged/[operationId]/sweep` `{}`, `POST .../staged/sweep` `{}` | One bounded step of deleting a finished or abandoned import's staged objects (below). The second form takes the session of the case that is due next. |

Objects are written before rows, so a row always has its object; a crash leaves at worst an object with no row, which the resumed batch finds present and leaves alone. Rows are written once (insert-once, no update, no delete, `OR REPLACE` refused by trigger). A resumed import asks `status`, sends only what is missing, and completes: the `resultsVersion` and `candidateId` are functions of the package bytes, so they equal those of an uninterrupted import (tested at every R2 put and every D1 row batch of the poc package).

## Stepped completion

`complete` does not pass the package through the one-request stager. The stepped stager (`src/lib/server/runtime/hosted/stepped-stager.ts`) stages the same version, rows and objects in bounded steps, and `native/service.ts` `importStepped` links as `importPackage` does (the same attempt claim, `requestSha256`, coverage and link). Progress is in the client's D1: `native_import_stage_run` (one row per operation: epoch, phase, cursor, lease) and `native_import_stage_fact` (what a step derived, write-once). A composition with no stepped stager keeps the old path: the whole verified package to `stager.stage` in one request.

| Phase | One step does |
| --- | --- |
| plan | Reads the manifest, datasets and asset index (not the previews), runs `inspectPackage`, `preparePackage`, the submission and folder checks and the quota preflight, and writes one fact per file asset naming its original. |
| originals-a | Reads and verifies a slice of the selected originals once and derives each fact by the stager's own rule. |
| validate-a | Validates with those facts and builds the exact-required-file-set coverage; writes its links. |
| originals-b | Derives the facts again by the storage rule with those links (`readOriginalFacts`), in slices. |
| begin | Compares the two derivations, validates, projects, takes the quota and writes the version row and the first file rows, in one batch with the run's move. |
| rows | Writes the remaining file rows and the read-model rows, a batch at a time, each moving the cursor. |
| objects | Copies each package file from its staged object to its content key (`writeOnce`). |
| verify | Heads every object against its row, then stores the version (the same seal batch). |
| readback | Reads the stored previews back, a slice at a time. |
| originals-d | Derives the facts a last time, after storage. |
| final | Reads the stored non-preview files back, validates once more, checks the read model digest and the version head, audits, and answers. |

A step claims a lease (`lease_id`, `lease_until_ms`) and commits in a batch whose first statement is a guard on that lease, the epoch, the phase, the cursor it read and an unexpired lease: a step that lost its lease, or ran twice, writes nothing and answers `busy` (409). A killed step leaves the last commit intact; its lease holds until it lapses (`leaseMs`, 60 s by default), then the next `complete` resumes from the stored cursor. A refusal restarts the run at `plan` in a new epoch (earlier facts are kept and ignored), so the same operation can be retried once the cause is fixed, as the one-request import's can.

**What a step holds.** The non-preview files (at most `structuredBytes`, 32 MiB by default, refused `over-budget` before any is read) and one slice of originals (at most `originalsPerStep` reads and `bytesPerStep` bytes). A preview is never held: its size, SHA-256 and `%PDF-` header were recorded in the ledger (`native_import_staged_file.pdf`) when it was uploaded and checked, and the validator takes those facts (`held`) instead of the bytes. Held previews give the same diagnostics, identity and read model as the bytes (`tests/case-package/held-previews.test.ts`).

**Bounds.** A step stops starting units at `originalsPerStep` originals, `bytesPerStep` bytes, `objectsPerStep` objects, `rowsPerStep` rows or `wallMsPerStep` wall time, always doing at least one unit. A request runs `stepsPerRequest` steps or until `wallMsPerRequest`. `stepCost(bounds, rowsPerBatch)` is the bound the tests hold the counted D1, R2 and session calls of every step to. Defaults (Workers Paid): 40 originals, 24 MiB, 100 objects, 2,000 rows, 20 s a step, 4 steps or 25 s a request. They are unmeasured on workerd.

**Original reads.** The one-request stager reads each original in four passes. The stepped one reads it in three (a, b, d): the stager's storage-side derivation (`createResultsStaging`'s own `readOriginalFacts`) and the independent one run over the same folder with nothing written between them, so they are one pass here. Each pass is reserved against the case's verification window (`maxVerifyObjectsPerCaseWindow`) as it runs; a window that cannot take a step answers `busy`.

**A package the intake cannot hold.** The client intake finalizes one file per submission revision (`file_count = 1`), and the stager selects every file asset's original from that one revision. A package with more than one original therefore cannot link on this base, stepped or not (`original-link-required`); the tests import the poc package with every document pointing at the one original a revision can hold, and a preview each. The originals phases are bounded for many originals and are tested against `readOriginalFacts` slice by slice, but no many-original package has been linked.

## Cleanup of staged objects

A finished import (a candidate exists for the operation) or an abandoned one (opened more than `sessionTtlMs`, seven days, ago, with no candidate and no recent run) is swept in bounded steps of at most `sweepObjects` (100) deletes: its staged files in path order, then its manifest. `native_import_cleanup` holds the position, so a killed sweep resumes. An object another live session of the case still needs (as a file or as its manifest) is kept: live means not swept, no candidate, and opened within the time to live or running within it. Only keys under `native-import/` can be deleted; a candidate's package objects (`pkg/`) and the originals (`orig/`) are never named. After a sweep, `put` and `complete` of an abandoned session answer `session-expired` (410); a finished one still answers its candidate. `open` sweeps one step of an expired session of the case before it answers (best effort, skipped when the plan's request budget could not afford it); `POST .../sweep` runs a step on demand. Nothing runs the sweep on a timer: a finished import is swept when someone calls it.

## Request budget

The import and staging routes are composed for Workers Paid: `WORKERS_PAID_REQUEST = {d1: 900, external: 4500}` (`import-composition.ts`; `services.ts` uses it, the other routes have budgets of their own). Cloudflare's Workers limits page (developers.cloudflare.com/workers/platform/limits/, read 27 October 2026) gives 10,000 subrequests per invocation on Paid, defines a subrequest as "any request a Worker makes using the Fetch API or to Cloudflare services like R2, KV, or D1" (so R2 and D1 binding calls count), and lists a separate "subrequests to internal services" row, 10,000 by default. D1's limits page (developers.cloudflare.com/d1/platform/limits/) gives 1,000 queries per invocation on Paid, a batch counting as one. `d1` keeps 10% of 1,000; `external` (the identity provider's session checks, which are fetches) is held under half of 10,000 so D1 and R2 have room even if it is one pool. `WORKERS_FREE_REQUEST` (45 and 45) stays for the tests and any Free composition.

## Per-request bounds

A batch carries at most 32 files and `min(12 MiB, ¾ × (maxRequestBytes − framing))` raw bytes (`stagedBounds`), so the base64 body fits the import budget's `maxRequestBytes`. Its cost is at most `stagedBatchCost(files, rowsPerBatch)`: D1 `9 + ceil(files / rowsPerBatch)`, R2 `1 + 3 × files`, subrequests R2 `+ 6`. The tests hold the counted calls to that bound. When the deployment composes a `requestBudget` (Workers Free: 45 and 45) a batch over it is refused `over-budget`. A listed file larger than one batch can carry is refused when the import is opened, not part-way.

## The reviewed ceiling

| Bound | Was | Now | Why |
| --- | ---: | ---: | --- |
| files in a package, `LIMITS.packageFiles`, manifest `maxItems`, `nativeImportBudget.maxFiles` | 1,024 | 8,192 | A v5-sized export lists about 40 datasets and indexes plus a preview per document and per extracted attachment: 1,689 + 1,308, about 3,050 files. 8,192 is 2.7 times that. The costs that grow with it (manifest size, one D1 row and one R2 object per file, one read per file at completion) are bounded in batches. |
| `manifestBytes` | 1 MiB | 4 MiB | 8,191 entries of about 300 bytes is 2.4 MiB. |
| `packageBytes` | 512 MiB | 2 GiB | Covers the whole 1.85 GB v5 export even if every byte were a package file. |
| zip `archiveEntries`, `archiveTotalBytes` | 1,024, 512 MiB | 8,192, 2 GiB | The zip transport of the same layout. |
| `fileBytes`, per-file 64 MiB; `originalBytes` 8 GiB | | unchanged | |

The ceiling is a safety limit. The deployment's `storageBudgets` and `importBudget` still decide what one client may import and must be set to a stated policy before a real export (a deployment value, not a code default).

## Known limits

- Corrections (`correct`) are still refused whenever a request budget is composed, as they read and stage a whole package in one request.
- The stepped stager's bounds, its per-step call counts and its memory are unmeasured on workerd; only the node:sqlite and in-memory R2 doubles ran.
- A file larger than one batch (12 MiB raw at most) cannot be sent.
- Memory per batch request (the body, its text, the decoded bytes) and the real call counts on D1 and R2 are unmeasured on workerd.

## Checks

```sh
scripts/agent-tools/receipt --name staged-import -- bun run --bun vitest run --config tests/results-review/native/vitest.config.ts
scripts/agent-tools/receipt --name staging-migration -- bun run --bun vitest run --config tests/hosted-foundation/native-runtime-migration/vitest.config.ts
scripts/agent-tools/receipt --name stepped-import -- bun run --bun test tests/results-review/native/stepped-import.test.ts tests/results-review/native/staged-cleanup.test.ts tests/case-package/held-previews.test.ts
```

`CLEARCASE_POC_DOCUMENTS=1689` (and optionally `CLEARCASE_POC_DIR`) runs the decisive test on the full 1,689-document poc corpus (about 1.8 GB, generated outside `/tmp` and the checkout); the default generates 60 documents once under `~/.cache/clearcase-rx27`.
