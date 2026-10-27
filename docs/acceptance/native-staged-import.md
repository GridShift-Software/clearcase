# Chunked, resumable results import (U15)

Local synthetic evidence only: node:sqlite stand-ins for D1, an in-memory R2, a recording stager and the real route modules. Not workerd, not deployed, not a provider or browser result. Migration 0006 is staged by `deploy/native-alpha/runtime-migration.ts` and has been applied to no D1.

## Why

The one-request import (`POST /operator/results/[caseId]/imports`) carries the whole package as UTF-8 text in one JSON body, so it cannot carry a PDF preview, and its limits (64 files, 8 MiB, 2 MiB per file in the live policy; 1,024 files in the schema) stop a v5-sized export (1,689 documents, previews, extracted attachments) before it starts. Workers Paid removes the CPU limit (`rx-cpu-probe.md`: about 0.5 s for a v5-sized validation). The limits that remain are wall time, subrequests and memory per request, so the work is split into bounded requests.

## Protocol

All four routes sit under `/operator/results/[caseId]/imports/staged` and take the one-request import's authority: verified staff, own client, the `operate` capability, decided before any body byte is read; every write is fenced on the live session and the grant as SQL.

| Step | Request | Does |
| --- | --- | --- |
| open | `POST .../staged` `{operationId, submissionRevisionId, manifest}` (manifest.json as text) | Checks the manifest alone: strict JSON, committed schema, recomputed `inputRevision.id` and `resultsVersion`, case, file, byte and batch budgets. Stores the manifest object, then the session row. |
| batch | `POST .../staged/[operationId]/files` `{files: {path: base64}}` | Checks every file against the manifest by size and SHA-256 first; one bad file refuses the whole batch and writes nothing. Stores the new objects in R2 (content-addressed per client and case), then their rows in D1. Files already accepted are left alone. |
| status | `GET .../staged/[operationId]` | Progress, the first 512 missing paths, `candidateId` once linked. |
| complete | `POST .../staged/[operationId]/complete` `{}` | Refuses `incomplete` while any file is missing. Otherwise reads every staged object back with a size and hash check and hands the whole package to the unchanged `importPackage`, so inspection, the request budget, the attempt claim, the stager, coverage and the link are exactly the one-request path's. A repeat answers the linked candidate without reading a file. |

Objects are written before rows, so a row always has its object; a crash leaves at worst an object with no row, which the resumed batch finds present and leaves alone. Rows are written once (insert-once, no update, no delete, `OR REPLACE` refused by trigger). A resumed import asks `status`, sends only what is missing, and completes: the `resultsVersion` and `candidateId` are functions of the package bytes, so they equal those of an uninterrupted import (tested at every R2 put and every D1 row batch of the poc package).

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

- **Completion holds the package in memory.** `complete` and the stager take the whole package as one map, so a Worker's 128 MB memory and one invocation's subrequests (about `4 × originals + files`) bound a package it can finish. The poc package (4.5 MB, 37 files) is far inside; a package of hundreds of MB of previews is not. Stepping the stager itself is the next unit.
- Staged objects are not deleted after completion: the storage binding the stager takes (`CloudR2`) has no delete. They are keyed by hash per client and case, so a retry reuses them, and they count against no quota.
- A file larger than one batch (12 MiB raw at most) cannot be sent.
- Memory per batch request (the body, its text, the decoded bytes) and the real call counts on D1 and R2 are unmeasured on workerd.

## Checks

```sh
scripts/agent-tools/receipt --name staged-import -- bun run --bun vitest run --config tests/results-review/native/vitest.config.ts
scripts/agent-tools/receipt --name staging-migration -- bun run --bun vitest run --config tests/hosted-foundation/native-runtime-migration/vitest.config.ts
```

`CLEARCASE_POC_DOCUMENTS=1689` (and optionally `CLEARCASE_POC_DIR`) runs the decisive test on the full 1,689-document poc corpus (about 1.8 GB, generated outside `/tmp` and the checkout); the default generates 60 documents once under `~/.cache/clearcase-rx27`.
