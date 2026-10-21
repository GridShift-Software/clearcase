# Storage proof: the local workerd legs (GRS-109)

[GRS-109](https://linear.app/vaper/issue/GRS-109) asks for proof of the per-client D1 and R2 layout, its integrity and its POC workload before production storage is built. Cloudflare stays pinned (GRS-26, 17 and 20 October 2026), so this unit runs only the legs that can pass on native workerd with local D1 and R2 and no Cloudflare account. Dian (`dianbrown`) owns the unpin and the cloud legs.

**Verdict at a156c2c559c8: PASS for the local legs; HOLD for the cloud legs.** Every local leg below passed at POC scale at `a156c2c559c8afc25e496624a75d3e6a8c8ce678` (exit 0, `evidence: true`). What stays HOLD, and the moment each needs, is [at the end](#what-stays-hold). The probe is a model of the storage design, not the product's storage: GRS-117 and GRS-118 implement it.

## Run it

From `tests/hosting-probe/storage/`, a workspace with its own pins and `bun.lock`. It is not a member of the root workspace.

```sh
bun install --frozen-lockfile        # once, online
bun run --bun probe                  # POC scale, about 7 minutes; writes .local/hosting-probe/storage/summary.json at the repo root
bun run --bun probe --check FILE     # exit 0 only for this runner's POC-scale PASS summary for HEAD
bun run --bun test:check             # mutates the committed summary and runs --check on each mutant
bun generate.ts                      # prints the synthetic corpus's counts and sizes
```

[`probe.ts`](../../../tests/hosting-probe/storage/probe.ts) has GRS-106's guards. It refuses (exit 2) a dirty tree, any Bun but 1.4.2, an installed package that differs from its pin, or a `node` that is really Bun. It re-runs itself inside [`tests/e2e/pilot/offline.sh`](../../../tests/e2e/pilot/offline.sh) (loopback only, the host resolver hidden), checks that again, and gives every child the same environment allowlist: a fresh `HOME` and XDG directories, `CI=1`, and no telemetry, error reports, `cf.json` fetch or dotenv. No account, login, token or Cloudflare request is possible. `--scale smoke` and `--allow-dirty` exist for working on the probe; neither can produce `evidence: true`. The local D1 and R2 state (about 13 GB at POC scale) is deleted at the end unless `--keep-state` is given; logs stay under `.local/hosting-probe/storage/<run>/logs`.

`evidence` is `true` only when every leg passes at POC scale, HEAD and the tree are unchanged, and the runner's checker refuses every mutation of its own summary (1,774 mutants at this run). The checker holds the whole summary to one exact shape: key sets, types and values, measurements included. Counts that the seeded corpus fixes are literals. Every timing must be above zero, so a zeroed field is refused too. The committed run is [evidence/storage-summary.json](evidence/storage-summary.json). It names the SHA it ran at.

Wrangler's dev proxy sometimes drops a request on its pooled connection to the Worker before the Worker runs. It answers a 500 in `text/plain` that starts `Error: Network connection lost.`, about 20 ms after the request, and retries only GET and HEAD itself. Two POC restores failed on it. Logging every restored entry showed the failed request never reached the Worker, and the same request passed on the next attempt. The runner now retries such a request up to twice, after 250 ms, and lists each retry with its leg in `devProxyRetries`. The upload leg's `retries` is that list's upload count. This run: 1 (`restore: POST /restore/packets/<id>/step (attempt 2)`). An answer from the Worker itself, always JSON or verified bytes, is never retried.

## What runs where

| Step | Host |
| --- | --- |
| `bun build src/worker.ts` (the Worker module, 66.8 KB, no `node:` or `bun:` import) | Bun 1.4.2 |
| Runner, corpus generator, HTTP requests, assertions, summary | Bun 1.4.2 |
| `wrangler dev --local`, `wrangler d1 execute --local`, `wrangler r2 object put/get/delete --local` | Node 26.10.0 hosts Wrangler 4.151.1 only |
| The Worker | native workerd 1.20261012.1, a descendant of Wrangler; the runner checks it in `/proc` |
| Offline packet check | `python3 -I` (`zipfile`, `hashlib`): an independent reader |

D1 and R2 are Miniflare's local implementations inside workerd. They are not Cloudflare's, so this run is not evidence of remote D1 or R2 behaviour, limits or latency.

## The synthetic corpus

[`generate.ts`](../../../tests/hosting-probe/storage/generate.ts) reproduces the counts and byte sizes that GRS-95 measured on the v5 sample. It uses none of the sample's content: every byte comes from the seed `grs-109`, and each original starts with a `SYNTHETIC ONLY` line. Original sizes are log-linear between the measured quantiles, with the middle band shaped so the total is exact.

| Quantity | v5 (GRS-95 aggregate) | Generated |
| --- | ---: | ---: |
| Originals | 1,662 | 1,662 |
| Original bytes | 3,211,390,882 | 3,211,390,882 |
| p50 / p90 / p99 | 209,920 / 1,153,434 / 33,030,144 | 210,189 / 1,153,669 / 32,648,591 |
| Largest | 258,590,305 | 258,590,305 |
| Over 32 MiB / over 100 MiB | 17 / 7 | 17 / 7 |
| Package files / bytes (chronology 1,827,097, bundles 1,613,368, caselines-index 1,188,230, assets.json 798,849) | 37 / 6,249,551 | 37 / 6,249,551 |
| Chronology list | 1,689 rows, 1,509,878 bytes | 1,689 rows, 1,509,878 bytes |
| Document rows (p50 1,287, p99 3,093, max 4,617 bytes) | 1,689, 2,342,785 bytes | 1,689, 2,342,785 bytes |
| Asset rows (embedded) / seed rows | 3,054 (1,308) / 7 | 3,054 (1,308) / 7 |

The p99 is 1.2% under its target because the curve also has to meet the 32 MiB step. The bytes are seeded noise, so they model storage volume, not compression, rendering or parsing. GRS-144's generator (`scripts/fixtures/`) is the one that makes a valid results package. Folding this size profile into its `poc` profile is a [follow-up](#follow-ups).

## Legs

Every leg ran at `a156c2c559c8afc25e496624a75d3e6a8c8ce678`, POC scale. Exit code 0.

| Leg | Research leg | What it asserts | Result |
| --- | --- | --- | --- |
| `build` | | Bun builds the Worker offline; the bundle imports no `node:`, `bun:` or CommonJS module | PASS |
| `provision` | | `schema.sql` applies to three deployments' D1 databases through Wrangler's CLI; clients A and B each get an identity row and an `identity/client.json` object of their own | PASS |
| `crossed-bindings` | wrong client | Client A's Worker bound to client B's database, or to B's bucket, answers 503 `crossed-binding` naming the binding on every read and write, and never names client B. A database with no identity row, or a bucket with no identity object, answers 503 `missing-identity`. Afterwards B's user work is byte for byte what it was, and neither bucket holds the object the crossed Workers were asked to store (9 refused requests) | PASS |
| `upload` | P2 (local path only), P3 (local) | 1,662 originals, 3,211,390,882 bytes, go through the Worker: 1,653 single PUTs with `put({sha256})` and 9 multipart uploads in 64 MiB parts. Finalize hashes every stored original whole before its row exists (3,211,390,882 bytes). A PUT whose bytes differ from its SHA-256 answers 422, finalizing an object that was never uploaded answers 409, a repeated PUT is a no-op, and a finalize with no `size` answers 400 naming the field. 0 failures, 0 retries | PASS |
| `import` | P5 (batch and recovery logic) | Staging, an attempt abandoned after the documents and half the assets, and recovery: the next `begin` deletes the staged rows in one batch (3,253 rows). Then every row is written again, and the version flips to `stored` in one guarded batch only when every count matches. A rows batch with an injected failing statement rolls back whole. A finish before the rows are complete, a write after `stored`, and a `begin` on a stored version are refused. Activation is one guarded batch, and a stale expected pointer is refused | PASS |
| `layout` | layout | The measured counts in [Layout](#the-layout-frozen-for-product-owners). A stored candidate's files are not served while another version is published | PASS |
| `range` | range delivery | Ranges `0-63`, `100-163`, `-64` and `n-` answer exactly those bytes with their `Content-Range`. Several ranges, a range past the end and a backwards range answer 416 with no bytes, and HEAD answers headers only. A whole original up to 32 MiB comes back exact. The largest (258,590,305 bytes) comes back whole through the two-pass path and as a 64 KiB range. Another case's asset, an unknown asset and client B's asset ids answer 404 | PASS |
| `user-work` | P4 | 100 concurrent adds give each store seq 1 to 50, with no gap or duplicate, and move the revision once each. The read-then-write control duplicated 98 of 100 seqs under the same load, so the probe can see the defect it rules out. A repeated `operationId` writes nothing. Of 20 concurrent replaces with one expected version, 1 is written and 19 are stale; then a stale remove, a current remove, and `gone`. The snapshot covers every `uw_` table that `sqlite_master` lists. A restore at a revision that moved is stale. A restore that fails after its deletes rolls back whole. A snapshot lacking a table is refused, naming the table. A restore at the current revision replaces the case's user work whole, after a durable pre-restore copy in R2. A restore racing 20 adds (this run: `restore-first`) keeps exactly the adds after its revision | PASS |
| `export` | P7 (packet build) | A complete case packet, a store-only ZIP64, is written to R2 as a multipart upload, one part per step (385 steps, 385 parts, 3,222,959,051 bytes, 1,706 entries: the manifest, user work, read model, results record, 37 package files, the list and every original). Every part but the last is exactly 8 MiB, which R2 requires, so an entry can span parts. Its SHA-256 and CRC-32 run across the steps (a resumable SHA-256 kept in `export_job.entry_state`), and every entry is checked against its recorded digest once its last byte is in. The packet is then sealed (hashed whole), downloaded through a two-pass verified read, and opened offline by Python's `zipfile`, which checks every entry's CRC-32 and the manifest's SHA-256 and size | PASS |
| `corruption` | P8 (detection, fail-closed on load) | 8 cases refused; see [Integrity](#integrity-which-check-catches-what) | PASS |
| `restore` | P7 (offline restore) | Client A's packet uploaded to client B's deployment is refused on open (409 `wrong-client`) and not kept. A fresh client A deployment opens the packet from its central directory and manifest, then copies every object entry, with R2 checking each against the manifest's SHA-256 and the archive's CRC-32. It rebuilds the version, read model, originals, activation and user work through the guarded import path. Its state digest equals the source's, taken before the corruption leg: rows, user work and every object. An original corrupted at the source is served intact from the restored copy. A second finish is refused | PASS |

## Acceptance items

| Item | Status at `a156c2c559c8` | Evidence |
| --- | --- | --- |
| Run P1–P8 where they apply, including wrong-client access, upload and finalize, integrity, concurrent user work, complete export, corruption and restore; no Node CPU proxy | PASS for P4, P5 (logic), P7, P8, wrong client, upload and finalize. HOLD for P1, P2, P3, P5's limit enforcement and P6 | legs above; no step ran on Node except Wrangler's host |
| Layout chosen from actual request, row and object counts; separate clients' resources and preview/published namespaces | PASS (local counts) | [Layout](#the-layout-frozen-for-product-owners); `crossed-bindings`; candidate files 404 in `layout` |
| Verify-on-load and fail-closed original integrity, with a proved range-delivery path; hashing never weakened | PASS | `range`, `corruption`; the whole object is hashed for every delivery, ranges included |
| POC-scale counts and byte sizes, synthetic; cold and warm reads, upload and export bursts, failure and retry, numeric budgets | PASS for counts, sizes, failure and recovery paths. Local timings are recorded below; they are **not budgets**. HOLD for numeric budgets | [Local measurements](#local-measurements-not-budgets) |
| Freeze storage, stable identities, export and backup interfaces; document actual placement | PASS for the interfaces below. HOLD for actual placement | [Interfaces](#frozen-interfaces) |
| Local-first legs on workerd (17 October addition) | PASS | every leg |

## Integrity: which check catches what

Each case is a corruption the `corruption` leg made on the source deployment, then requested.

| Case | How it was made | Caught by | Answer |
| --- | --- | --- | --- |
| Bit flip at rest in an original, outside bytes 0–63; same size and etag | one byte at offset 100 of its blob in the local R2 store | the whole-object SHA-256 on delivery | `Range: bytes=0-63`, GET and HEAD: 410 `changed-original`, no original bytes |
| The same corrupted original reached by an export | export step | the entry's SHA-256 over the bytes written into the packet, across parts when it spans them | 410; the job is `failed`, its multipart upload aborted, and no packet object exists |
| Truncated original (a credential holder's PUT) | `wrangler r2 object put` | the recorded size | 410 (`size`), no bytes |
| Replaced original, same size (a credential holder's PUT) | `wrangler r2 object put` | the whole-object SHA-256 | 410 (`sha256`), no bytes |
| Deleted original | `wrangler r2 object delete` | the R2 read | 410 `missing-original` |
| Bit flip at rest in a package file (`pkg/`) | one byte of the chronology dataset's blob | GRS-12's version check and the file route | 410 naming the key; none of the file served |
| Replaced list (`rm/`), same size | `wrangler r2 object put` | the list's SHA-256 | 410 on the chronology view |
| Interrupted import | an attempt abandoned mid-rows | the staging state and the guarded flip | nothing served from the staged version; the retry starts clean (`import`) |
| Partial restore | a failing statement after the deletes; a snapshot lacking a table | D1 batch atomicity; the `sqlite_master` table list | rolled back whole; refused, naming the table (`user-work`) |
| Upload whose bytes differ from the declared SHA-256 | a PUT of other bytes | R2's `put({sha256})` | 422, nothing stored (`upload`) |
| Packet entry corrupted between export and restore | not injected | R2's `put({sha256})` against the manifest, then the CRC-32 | refused by construction; no run injected it ([follow-up](#follow-ups)) |
| Bytes changed between the two passes of a large whole GET, keeping the etag | not injected | the second pass's hash | the response errors before its end, after bytes left. This is the one residual window, and only for whole GETs of objects over 32 MiB |

A range of up to 32 MiB, and any original up to 32 MiB, comes from one pass that hashes the whole object. A larger whole GET hashes first, then streams a second read that is pinned to the verified etag with `onlyIf` and hashed again. The cost of this rule on the largest original is in [Local measurements](#local-measurements-not-budgets). Caching verification per isolate, or trusting the ETag, would weaken GRS-12's rule. This unit does neither; that is a design-gate decision for the user (GRS-95, Integrity).

## The layout, frozen for product owners

**Chosen:** one Worker, one D1 database and one R2 bucket per client. Each database and bucket carries its client's identity, provisioned out of band, and the Worker refuses to serve anything until both match its deployment. Package files and the chronology list live in R2. The read model and all user work live in D1, written through `json_each`.

| Choice | Measured at POC scale | Why |
| --- | --- | --- |
| Package files in R2 (`pkg/`), not D1 BLOBs | as BLOBs they add 6,291,456 bytes to D1 per version, against 4,386,816 bytes for a version's rows; the largest value is 1,827,097 bytes, 91% of D1's 2,000,000-byte limit. Local D1 accepted a 2,000,001-byte value, so it does not enforce that limit and cannot prove a layout against it | R2 keeps the exact bytes beside the originals and leaves D1 headroom. The limit holds only on remote D1 |
| Read model in D1, written through `json_each` | 6 statements for every row of a version, against 206 with bound rows. Local D1 refuses a 101st bound parameter, so bound rows need at least 33 rows a statement. The largest invocation took 47 statements; 25,458 rows were written in the import leg, both attempts and both arms | fewer statements per invocation, which matters under the 50-query (Free) and 1,000-query (Paid) limits that local workerd does not enforce |
| One database per client, results and user work in separate tables | a document page costs 1 D1 statement and 0 R2 operations; the chronology view 1 statement and 1 R2 GET; a range of an original 1 statement and 1 R2 GET (a whole-object read). Activation, a restore and the import's flip are each one batch | activation (`active`, `activation_log` and the version state) and a restore need one atomic batch, and `batch()` is per database. The cost: a D1 Time Travel restore rolls back user work too, so per-case user-work restores use the R2 snapshots (`backup/`). A second database is the alternative if P6 shows Time Travel must restore results alone |
| Originals content-addressed (`orig/<sha256>`), write-once | 1,662 objects, 9 of them multipart; a finalize takes 2 R2 operations | a repeat upload is a no-op, and dedupe is free |
| Export as a multipart packet, one 8 MiB part per step | at most 45 R2 operations and 6 D1 statements in one step; 385 steps | each invocation stays bounded. A one-invocation export of 1,662 originals would exceed the Free plan's subrequest limit. R2 (local R2 too) completes a multipart upload only when every part but the last has one size and the last is no larger: the first POC run, with one part per group of entries, failed at completion (10048) |

**R2 keys** (per client bucket):

```
identity/client.json                    {"client_id": …}; provisioned with the deployment, never written by the Worker
orig/<sha256>                           originals, content-addressed, write-once, recorded only after finalize hashed them
pkg/<resultsVersion>/<path>             exact package files, put({sha256})
rm/<resultsVersion>/chronology.json     the chronology list, put({sha256})
backup/<caseId>/<label>-<rev>-<sha256>.json   user-work snapshots: on demand and before every restore
export/<caseId>/<exportId>.zip          case packets (ZIP64, store-only)
import/<packetId>.zip                   a packet uploaded for restore
```

Previews (GRS-118) take `preview/<resultsVersion>/<assetId>`, beside `pkg/`, so a candidate's previews are never under a published version's key. Publication is the D1 `active` pointer: only the active version's files are served.

**D1 tables:** [`schema.sql`](../../../tests/hosting-probe/storage/schema.sql). `storage_identity`; `batch_guard` (a guarded batch's first statement inserts NULL here when its condition fails, which rolls the batch back); `results_version` with `staging` and `stored` states and the expected counts; `package_file`, `document`, `asset` and `seed`, keyed by `(version_id, …)`; `original` and `case_original`; `active` and `activation_log`; `case_rev`, plus every `uw_*` table, which must have a `case_id` column; `export_job` and `export_entry`.

## Frozen interfaces

These are the contracts the probe proved. Product owners implement them, so GRS-117 (store), GRS-118 (assets) and the export owner do not re-derive them.

- **Identities.** A client is its deployment (`CLEARCASE_CLIENT_ID`), never a request field. A case is an opaque id (`ids.ts` `id('case', …)`). A results version is `sha256:<hex>` of its package, immutable once `stored`. An original is its SHA-256 and size. An asset id is case-scoped and binds to exactly one original: re-finalizing it with another digest is refused. A user-work row is `(case_id, row_id)`, with a version that changes on every write, and `case_rev` orders every write in a case.
- **Storage gate.** Every request reads `storage_identity` and `identity/client.json` first, and per isolate after that. A missing, empty or other-client value is 503 (`missing-identity` or `crossed-binding`, naming the binding), with nothing read or written. The other client's id is never echoed.
- **Delivery.** `read(asset, range?)` hashes the whole stored object against its recorded SHA-256 and size before any byte leaves. The answers are 410 `changed-original` or `missing-original` with no bytes, 416 for an unsatisfiable or multiple range, and 206 with `Content-Range` otherwise.
- **Import.** `begin(version, expected counts, list digest)`, then `putFile`, `putList` and `rows(table, rows)` while staging, then `finish()`, which stores the version only when every count and object matches. A `begin` on a staging version deletes its rows first. `activate(version, expected)` is one guarded batch.
- **User work.** `add(fields, operationId)` is idempotent per operation and assigns `seq` inside its statement. `replace` and `remove(rowId, expected)` answer `written`, `stale` or `gone`. `snapshot()` covers every `uw_*` table. `restore(expectedRev, snapshot)` writes a pre-restore snapshot to R2 first, then runs one batch. It refuses a snapshot that lacks or adds a table or a column.
- **Export.** `start()` fixes the manifest (`clearcase.case-packet/1`: client, case, resultsVersion, every entry's path, kind, SHA-256 and size). `step()` writes the next 8 MiB part; a step that loses a race on the job is refused (409 `stale-step`), and R2 refuses completion if a racer's part replaced a recorded one. `seal()` hashes the packet. Downloads are verified. A packet restores only into a deployment of the same client.
- **Backup.** User-work snapshots (`clearcase.user-work/1`) in R2 under `backup/`, with their SHA-256 in the key. Whole-database recovery is D1 Time Travel (HOLD, P6).

## Local measurements (not budgets)

These are wall times on one host (20 threads), local workerd and Miniflare's D1 and R2 on local disk, while other worktrees ran their own gates. They are not Workers isolate figures. None of them is a budget, and none supports a latency claim.

| Measure | Local value |
| --- | ---: |
| Upload and finalize of 1,662 originals (3,211,390,882 bytes) | 68,514 ms |
| Import of one version (both attempts, plus the bound-row arm) | 6,734 ms |
| Document page: cold (first request on a fresh workerd) / warm (median of 5) | 30.7 / 6.0 ms |
| Chronology view (1.5 MB list verified and parsed): cold / warm | 13.6 / 7.6 ms |
| 64 KiB range of the largest original (258,590,305 bytes, hashed whole first) | 2,464 ms |
| The largest original whole (two passes) | 6,368 ms |
| Export build and seal | 104,708 ms |
| Offline packet check (Python) | 2,702 ms |
| Restore into the fresh deployment (upload, steps, finish) | 109,378 ms |
| Peak resident set of the workerd processes (process memory, not an isolate's 128 MB) | range leg 466,411,520 bytes; export leg 1,041,293,312 bytes |

## What stays HOLD

Each of these needs moment **M2**: Workers Paid plus R2 on an account Dian unpins, with D1 and R2 created in the EU jurisdiction. They are listed in the summary's `hold` array.

- **P1 page latency** from a South African vantage point, cold and warm isolates, and the **cold-isolate fraction** under real traffic. This decides what per-request whole-object verification costs.
- **P2 presigned-PUT burst** of about 1,700 objects through the S3 endpoint. This run uploaded through the Worker binding only.
- **P3 verification-job CPU** against the Workers CPU limit, and whether a presigned PUT can enforce a SHA-256.
- **P5 enforcement** of the per-invocation D1 query and subrequest limits. Local workerd enforces neither; the counts above are what the design stays under.
- **P6 D1 Time Travel** restore and undo, and `wrangler d1 export` duration on a 45 MB database.
- **Actual EU placement** of D1 and R2. Nothing here was placed anywhere: no residency claim is made.
- **Numeric load, latency and memory budgets**, which come from P1 to P3.

## Follow-ups

- Inject a corrupted entry into a packet between export and restore, so that path is shown, not only constructed.
- Fold the v5 size profile (`generate.ts` `V5`) into GRS-144's `scripts/fixtures` `poc` profile, so one generator serves both.
- The large whole-GET second-pass window (the last row of [Integrity](#integrity-which-check-catches-what)) is for the design gate: accept it, or cap whole GETs at a buffered size and serve larger originals only by range.
- The time a restore or export takes per step on real Workers (P3, P7 CPU) decides the step sizes (8 MiB parts, 64 MiB restore steps). The export hashes in JavaScript (about 220 MB/s under Bun) because workerd's DigestStream cannot carry its state between invocations; its CPU cost per step is part of P3.
