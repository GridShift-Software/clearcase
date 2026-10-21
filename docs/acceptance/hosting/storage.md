# Storage proof: the local workerd legs (GRS-109)

[GRS-109](https://linear.app/vaper/issue/GRS-109) asks for proof of the per-client D1 and R2 layout, its integrity and its POC workload before production storage is built. Cloudflare stays pinned (GRS-26, 17 and 20 October 2026), so this unit runs only the legs that can pass on native workerd with local D1 and R2 and no Cloudflare account. Dian (`dianbrown`) owns the unpin and the cloud legs.

**Verdict at b9271a860717: PASS for the local legs; HOLD for the cloud legs.** Every local leg below passed at POC scale at `b9271a86071709cff1fa307dd5ef1abc0b1aae4e` (exit 0, `evidence: true`). What stays HOLD, and the moment each needs, is [at the end](#what-stays-hold). The probe is a model of the storage design, not the product's storage: GRS-117 and GRS-118 implement it.

## Run it

From `tests/hosting-probe/storage/`, a workspace with its own pins and `bun.lock`. It is not a member of the root workspace.

```sh
bun install --frozen-lockfile        # once, online
bun run --bun probe                  # POC scale, about 9 minutes; writes .local/hosting-probe/storage/summary.json at the repo root
bun run --bun probe --check FILE     # exit 0 only for this runner's POC-scale PASS summary for HEAD
bun run --bun test:check             # mutates the committed summary and runs --check on each mutant
bun generate.ts                      # prints the synthetic corpus's counts and sizes
```

[`probe.ts`](../../../tests/hosting-probe/storage/probe.ts) has GRS-106's guards. It refuses (exit 2) a dirty tree, any Bun but 1.4.2, an installed package that differs from its pin, or a `node` that is really Bun. It re-runs itself inside [`tests/e2e/pilot/offline.sh`](../../../tests/e2e/pilot/offline.sh) (loopback only, the host resolver hidden), checks that again, and gives every child the same environment allowlist: a fresh `HOME` and XDG directories, `CI=1`, and no telemetry, error reports, `cf.json` fetch or dotenv. No account, login, token or Cloudflare request is possible. `--scale smoke` and `--allow-dirty` exist for working on the probe; neither can produce `evidence: true`. The local D1 and R2 state (about 13 GB at POC scale) is deleted at the end unless `--keep-state` is given; logs stay under `.local/hosting-probe/storage/<run>/logs`.

`evidence` is `true` only when every leg passes at POC scale, HEAD and the tree are unchanged, and the runner's checker refuses every mutation of its own summary (2,124 mutants at this run). The checker holds the summary to one exact shape: the same keys and types at every level; the run's identity as literals (schema, SHA, scale, seed, pins, hosts, `evidence`, `failure`); the counts the seeded corpus and the legs fix as literals (corpus counts and sizes, layout counts, how many refusals each guard leg reaches); and a number above zero for every timing, so a zeroed field is refused too. It does not hold to the value what varies from run to run: a measured count such as the export's entries, parts and steps or the recovered rows, the retries, the artifact digest, an assertion's wording, or a timing. A hand edit of one of those passes `--check`; what shows it is the SHA, the run's logs and a rerun. The committed run is [evidence/storage-summary.json](evidence/storage-summary.json). It names the SHA it ran at.

Wrangler's dev proxy sometimes drops a request on its pooled connection to the Worker before the Worker runs. It answers a 500 in `text/plain` that starts `Error: Network connection lost.`, about 20 ms after the request, and retries only GET and HEAD itself. Two POC restores failed on it. Logging every restored entry showed the failed request never reached the Worker, and the same request passed on the next attempt. The runner now retries such a request up to twice, after 250 ms, and lists each retry with its leg in `devProxyRetries`. The upload leg's `retries` is that list's upload count. This run: 1 (`restore: POST /restore/packets/<id>/step (attempt 2)`); a restore step is also safe to repeat now, since it writes each key once. An answer from the Worker itself, always JSON or verified bytes, is never retried.

## What runs where

| Step | Host |
| --- | --- |
| `bun build src/worker.ts` (the Worker module, 78.3 KB, no `node:` or `bun:` import) | Bun 1.4.2 |
| Runner, corpus generator, HTTP requests, assertions, summary | Bun 1.4.2 |
| `wrangler dev --local`, `wrangler d1 execute --local`, `wrangler r2 object put/get/delete --local` | Node 26.10.0 hosts Wrangler 4.151.1 only |
| The Worker | native workerd 1.20261012.1, a descendant of Wrangler; the runner checks it in `/proc` |
| Offline backup check | `python3 -I` (`zipfile`, `hashlib`): an independent reader |

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

Every leg ran at `b9271a86071709cff1fa307dd5ef1abc0b1aae4e`, POC scale. Exit code 0.

| Leg | Research leg | What it asserts | Result |
| --- | --- | --- | --- |
| `build` | | Bun builds the Worker offline; the bundle imports no `node:`, `bun:` or CommonJS module | PASS |
| `provision` | | `schema.sql` applies to three deployments' D1 databases through Wrangler's CLI; clients A and B each get an identity row and an `identity/client.json` object of their own | PASS |
| `crossed-bindings` | wrong client | Client A's Worker bound to client B's database, or to B's bucket, answers 503 `crossed-binding` naming the binding on every read and write, and never names client B. A database with no identity row, or a bucket with no identity object, answers 503 `missing-identity`. Afterwards B's user work is byte for byte what it was, and neither bucket holds the object the crossed Workers were asked to store (9 refused requests) | PASS |
| `upload` | P2 (local path only), P3 (local) | 1,662 originals, 3,211,390,882 bytes, go through the Worker: 1,653 single PUTs with `put({sha256})` and 9 multipart uploads in 64 MiB parts. Finalize hashes every stored original whole before its row exists (3,211,390,882 bytes). A PUT whose bytes differ from its SHA-256 answers 422, finalizing an object that was never uploaded answers 409, a repeated PUT is a no-op, and a finalize with no `size` answers 400 naming the field. 0 failures, 0 retries | PASS |
| `import` | P5 (batch and recovery logic) | Staging, an attempt abandoned after the documents and half the assets, and recovery: the next `begin` deletes the staged rows in one batch (3,253 rows). Then every row is written again, and the version flips to `stored` in one guarded batch only when every count matches. A rows batch with an injected failing statement rolls back whole. A finish before the rows are complete, a write after `stored`, and a `begin` on a stored version are refused. Activation is one guarded batch, and a stale expected pointer is refused | PASS |
| `layout` | layout | The measured counts in [Layout](#the-layout-frozen-for-product-owners). A stored candidate's files are not served while another version is published | PASS |
| `range` | range delivery | Ranges `0-63`, `100-163`, `-64` and `n-` answer exactly those bytes with their `Content-Range`. Several ranges, a range past the end and a backwards range answer 416 with no bytes, and HEAD answers headers only. A whole original up to 32 MiB comes back exact. The largest (258,590,305 bytes) comes back whole through the two-read path and as a 64 KiB range. Another case's asset, an unknown asset and client B's asset ids answer 404 | PASS |
| `write-once` | | `orig/<sha256>` is never deleted or overwritten once an original or a D1 row holds it. A finalize from a second case with the same SHA-256 and a wrong size answers 409 `digest-mismatch`, and the first case's original stays stored and served byte for byte (the review's probe 2: it used to answer 422 and delete it). A multipart `complete` over a key that appeared since the upload began answers 409 `conflicting-object` and the key is unchanged. A multipart object whose bytes are not its key's finalizes to 409, is not recorded, and is not deleted. An asset id re-bound to another original answers 409. 4 refused writes | PASS |
| `two-pass` | range delivery | A 40 MiB original, over the 32 MiB buffer. Unchanged, the whole GET and a 35 MiB range answer exactly their bytes. With one byte of its R2 blob changed after the headers came back (the review's probe 3), each of three reads ends short of its last chunk: the whole GET, a 35 MiB range with the byte inside it, and one with the byte outside it (the digest covers the whole object) | PASS |
| `user-work` | P4 | 100 concurrent adds give each store seq 1 to 50, with no gap or duplicate, and move the revision once each. The read-then-write control duplicated 98 of 100 seqs under the same load, so the probe can see the defect it rules out. A repeated `operationId` writes nothing. Of 20 concurrent replaces with one expected version, 1 is written and 19 are stale; then a stale remove, a current remove, and `gone`. The snapshot covers every `uw_` table that `sqlite_master` lists. A restore at a revision that moved is stale. A restore that fails after its deletes rolls back whole. A snapshot lacking a table, adding one, or changing a table's columns is refused, naming the table. A restore at the current revision replaces the case's user work whole, after a durable pre-restore copy in R2. A restore racing 20 adds (this run: `restore-first`) keeps exactly the adds after its revision | PASS |
| `export` | P7 (backup build) | A case backup (`clearcase.case-backup/1`, see [Frozen interfaces](#frozen-interfaces)), a store-only ZIP64, is written to R2 as a multipart upload, one part per step (385 steps, 385 parts, 3,222,959,051 bytes, 1,706 entries: the manifest, user work, read model, results record, 37 package files, the list and every original). Every part but the last is exactly 8 MiB, which R2 requires, so an entry can span parts. Its SHA-256 and CRC-32 run across the steps (a resumable SHA-256 kept in `export_job.entry_state`), and every entry is checked against its recorded digest once its last byte is in. The backup is then sealed (hashed whole), downloaded through a two-read verified stream, and opened offline by Python's `zipfile`, which checks every entry's CRC-32 and the manifest's SHA-256 and size, and the manifest's format. A second download with one byte of the backup changed after its headers ends short of its last chunk | PASS |
| `corruption` | P8 (detection, fail-closed on load) | 8 cases refused; see [Integrity](#integrity-which-check-catches-what) | PASS |
| `restore` | P7 (offline restore) | Client A's backup uploaded to client B's deployment is refused on open (409 `wrong-client`) and not kept. A fresh client A deployment opens the backup, naming its case, from its central directory and manifest, then copies every object entry, with the archive's CRC-32 checked before each write and R2 checking each write against the manifest's SHA-256. It rebuilds the version, read model, originals and user work through the guarded import path, and activates the version in the same batch that stores it. Its state digest equals the source's, taken before the corruption leg: rows, user work and every object. An original corrupted at the source is served intact from the restored copy. A second finish is refused | PASS |
| `restore-guards` | P7 (restore refusals) | Small synthetic backups, built with the Worker's own ZIP writer and restored into the same deployment. A step whose archive CRC-32 is wrong, for an original already stored, answers 422 `crc-mismatch` and the original stays (it used to be deleted). A step whose target key holds other bytes answers 409 `conflicting-object` and leaves them. `open`, `step` and `finish` naming a case other than the backup's answer 409 `wrong-case`; a version that belongs to another case answers 409 `version-of-another-case`, in `step` and in `finish`; a stored version answers 409 `already-restored`; a case that already has an active version answers 409 `case-live`; none of them changes either case. A backup whose user work lacks a table the deployment has is refused before anything is written (422 `snapshot-incomplete`, case unchanged), and the corrected backup of the same case and version then restores, with its pre-restore backup written first and present in R2 under its SHA-256. A backup whose results record expects more documents, assets, seeds or files than its rows carry, or whose rows repeat a key or retype a value, or whose user work repeats a `uw_note` key or leaves its NOT NULL `body` null, is refused before anything is written (422 `invalid-packet` naming the key, column or table, case unchanged: no version, original, revision or user work), and the corrected backup of the same case and version restores. `stale` from the first batch and `not-staging` need a writer that changes the case between two statements of one call, so the probe does not reach them. An original that another case shares, stored and recorded through multipart (R2 keeps no SHA-256 for it), is accepted by `step` and `finish`; an object nothing records is still refused. An original record that names another case binds nothing in it. 16 refusals | PASS |

## Acceptance items

| Item | Status at `b9271a860717` | Evidence |
| --- | --- | --- |
| Run P1–P8 where they apply, including wrong-client access, upload and finalize, integrity, concurrent user work, complete export, corruption and restore; no Node CPU proxy | PASS for P4, P5 (logic), P7, P8, wrong client, upload and finalize. HOLD for P1, P2, P3, P5's limit enforcement and P6, and for P4 to P6 against the two-database layout arm | legs above; no step ran on Node except Wrangler's host |
| Layout chosen from actual request, row and object counts; separate clients' resources and preview/published namespaces | Chosen structurally, from the counts of one layout; the comparison against the two-database arm is HOLD (it needs P4 to P6 against both layouts, and P6 is HOLD). PASS for the counts, separate clients and the published namespace | [Layout](#the-layout-frozen-for-product-owners); `crossed-bindings`; candidate files 404 in `layout` |
| Verify-on-load and fail-closed original integrity, with a proved range-delivery path; hashing never weakened | PASS | `range`, `corruption`, `two-pass`, `write-once`; the whole object is hashed for every delivery, ranges included; beyond 32 MiB the second read is hashed too, with its last chunk held ([what leaves, and when](#integrity-which-check-catches-what)) |
| POC-scale counts and byte sizes, synthetic; cold and warm reads, upload and export bursts, failure and retry, numeric budgets | PASS for counts, sizes, failure and recovery paths. Local timings are recorded below; they are **not budgets**. HOLD for numeric budgets | [Local measurements](#local-measurements-not-budgets) |
| Freeze storage, stable identities, export and backup interfaces; document actual placement | PASS for the interfaces below that a leg exercises; the ones marked unproven there have no leg. HOLD for actual placement | [Interfaces](#frozen-interfaces) |
| Local-first legs on workerd (17 October addition) | PASS | every leg |

## Integrity: which check catches what

Each case is a corruption the `corruption` leg made on the source deployment, then requested.

| Case | How it was made | Caught by | Answer |
| --- | --- | --- | --- |
| Bit flip at rest in an original, outside bytes 0–63; same size and etag | one byte at offset 100 of its blob in the local R2 store | the whole-object SHA-256 on delivery | `Range: bytes=0-63`, GET and HEAD: 410 `changed-original`, no original bytes |
| The same corrupted original reached by an export | export step | the entry's SHA-256 over the bytes written into the backup, across parts when it spans them | 410; the job is `failed`, its multipart upload aborted, and no backup object exists |
| Truncated original (a credential holder's PUT) | `wrangler r2 object put` | the recorded size | 410 (`size`), no bytes |
| Replaced original, same size (a credential holder's PUT) | `wrangler r2 object put` | the whole-object SHA-256 | 410 (`sha256`), no bytes |
| Deleted original | `wrangler r2 object delete` | the R2 read | 410 `missing-original` |
| Bit flip at rest in a package file (`pkg/`) | one byte of the chronology dataset's blob | GRS-12's version check and the file route | 410 naming the key; none of the file served |
| Replaced list (`rm/`), same size | `wrangler r2 object put` | the list's SHA-256 | 410 on the chronology view |
| Interrupted import | an attempt abandoned mid-rows | the staging state and the guarded flip | nothing served from the staged version; the retry starts clean (`import`) |
| Partial restore | a failing statement after the deletes; a snapshot lacking a table | D1 batch atomicity; the `sqlite_master` table list | rolled back whole; refused, naming the table (`user-work`) |
| Upload whose bytes differ from the declared SHA-256 | a PUT of other bytes | R2's `put({sha256})` | 422, nothing stored (`upload`) |
| Backup entry whose archive CRC-32 is wrong, at restore | a backup built with one wrong CRC-32 in its central directory (`restore-guards`) | the CRC-32 over the whole entry, before any write | 422 `crc-mismatch`; nothing written, and a key that already holds the bytes stays |
| Backup whose counts or keys disagree with its rows | a results record expecting 2 documents over a backup that carries 1 (`restore-guards`) | the counts and keys checked in `finish` before the first write | 422 `invalid-packet`; no version, original, revision or user work is written, and the corrected backup restores |
| Backup whose user work breaks a key or NOT NULL of its table | a backup with one `uw_note` key twice, and one with a null `body` (`restore-guards`) | each `uw_*` table's PRIMARY KEY, UNIQUE and NOT NULL columns, read from the schema, checked in `finish` before the first write | 422 `invalid-packet` naming `uw_note`; the case is as it was (it used to answer 500 after the staging rows were written). Two register rows whose `seq` is `1` and `"01"` (one INTEGER key) are refused the same way |
| Backup entry corrupted between export and restore | not injected | R2's `put({sha256})` against the manifest | refused by construction (nothing stored on a mismatch); no run injected it ([follow-up](#follow-ups)) |
| Bytes changed between the two reads of a delivery over 32 MiB (a whole GET, a range, a backup download), keeping the etag | one byte of the blob changed after the headers came back (`two-pass`, `export`) | the second read's SHA-256 over the whole object, with the last chunk held until it matches | the response ends short of its last chunk. The bytes before that chunk have already left |

A range of up to 32 MiB, and any original up to 32 MiB, comes from one pass that hashes the whole object before any byte leaves. A delivery beyond that (a whole GET, a range of more than 32 MiB, a backup download) hashes the whole object first, then streams a second read pinned to the verified ETag with `onlyIf`, hashes that read again as it goes, and holds back the last chunk until the digest and length are the recorded ones. A range is checked against the whole object's digest, so a byte outside the range fails it too.

**What leaves, and when.** The second read's bytes before its last chunk leave before its digest is known. The last chunk and the end of the response leave only after it matched. If the object changed between the two reads, the response ends short of its last chunk: the bytes of the changed object that already left have been sent, and the response never completes. What a client does with a response that ends early depends on the client: this probe's Bun client received the shorter body without an exception, so a client must compare the bytes it received with the recorded size. It is not true that no byte of a changed object leaves, and the probe does not claim it.

The cost of this rule on the largest original is in [Local measurements](#local-measurements-not-budgets): a 35 MiB range of an object reads all of it twice. GRS-12 verifies on first serve per isolate. This probe hashes on every delivery, which is stricter than GRS-12 and costs a whole-object read each time; whether to relax it to GRS-12's rule is a design-gate decision for the user (GRS-95, Integrity).

## The layout, frozen for product owners

**Chosen:** one Worker, one D1 database and one R2 bucket per client. Each database and bucket carries its client's identity, provisioned out of band, and the Worker refuses to serve anything until both match its deployment. Package files and the chronology list live in R2. The read model and all user work live in D1, written through `json_each`.

| Choice | Measured at POC scale | Why |
| --- | --- | --- |
| Package files in R2 (`pkg/`), not D1 BLOBs | as BLOBs they add 6,291,456 bytes to D1 per version, against 4,386,816 bytes for a version's rows; the largest value is 1,827,097 bytes, 91% of D1's 2,000,000-byte limit. Local D1 accepted a 2,000,001-byte value, so it does not enforce that limit and cannot prove a layout against it | R2 keeps the exact bytes beside the originals and leaves D1 headroom. The limit holds only on remote D1 |
| Read model in D1, written through `json_each` | 6 statements for every row of a version, against 206 with bound rows. Local D1 refuses a 101st bound parameter, so bound rows need at least 33 rows a statement. The largest invocation took 47 statements; 25,458 rows were written in the import leg, both attempts and both arms | fewer statements per invocation, which matters under the 50-query (Free) and 1,000-query (Paid) limits that local workerd does not enforce |
| One database per client, results and user work in separate tables | a document page costs 1 D1 statement and 0 R2 operations; the chronology view 1 statement and 1 R2 GET; a range of an original 1 statement and 1 R2 GET (a whole-object read). Activation, a restore and the import's flip are each one batch | activation (`active`, `activation_log` and the version state) and a restore need one atomic batch, and `batch()` is per database. The cost: a D1 Time Travel restore rolls back user work too, so per-case user-work restores use the R2 snapshots (`backup/`). A second database is the alternative if P6 shows Time Travel must restore results alone. That comparison (P4 to P6 against both layouts, which GRS-95 says choosing needs) is not run: this layout is chosen structurally, from its counts, and the comparison is HOLD |
| Originals content-addressed (`orig/<sha256>`), write-once | 1,662 objects, 9 of them multipart; a finalize takes 2 R2 operations | a repeat single PUT of an original stored through a single PUT is a no-op (one stored through multipart answers 409, as R2 keeps no SHA-256 for it), and dedupe is free. The Worker never deletes or overwrites such a key; the rule and every site that writes or deletes in R2 are in [the table below](#r2-writes-and-deletes-every-site) |
| Export as a multipart backup, one 8 MiB part per step | at most 45 R2 operations and 6 D1 statements in one step; 385 steps | each invocation stays bounded. A one-invocation export of 1,662 originals would exceed the Free plan's subrequest limit. R2 (local R2 too) completes a multipart upload only when every part but the last has one size and the last is no larger: the first POC run, with one part per group of entries, failed at completion (10048) |

**R2 keys** (per client bucket):

```
identity/client.json                    {"client_id": …}; provisioned with the deployment, never written by the Worker
orig/<sha256>                           originals, content-addressed, write-once, recorded only after finalize hashed them
pkg/<resultsVersion>/<path>             exact package files, put({sha256})
rm/<resultsVersion>/chronology.json     the chronology list, put({sha256})
backup/<caseId>/<label>-<rev>-<sha256>.json   user-work snapshots: on demand and before every restore
export/<caseId>/<exportId>.zip          case backups (ZIP64, store-only)
import/<packetId>.zip                   a backup uploaded for restore
```

Previews (GRS-118) take `preview/<resultsVersion>/<assetId>`, beside `pkg/`, so a candidate's previews are never under a published version's key. No code writes `preview/` yet, so that namespace is unproven here. Publication is the D1 `active` pointer: only the active version's files are served.

### R2 writes and deletes, every site

The rule: **the Worker never deletes or overwrites a key that a D1 row records or that already holds verified bytes.** A repeat of the same bytes is a no-op where R2 holds their SHA-256, and anything else answers 409; a repeat single PUT of an original stored through multipart answers 409 too, because R2 keeps no SHA-256 for a multipart object. The table lists every `put`, `delete`, multipart `create`, `complete` and `abort` in [`worker.ts`](../../../tests/hosting-probe/storage/src/worker.ts) on `orig/`, `pkg/`, `rm/`, `backup/`, `preview/` and the scratch prefixes.

| Site | Keys | What it does | Disposition |
| --- | --- | --- | --- |
| single PUT | `orig/<sha>` | `head` first: the same checksum and size is a no-op, anything else 409 `conflicting-object` (an original stored through multipart has no checksum, so a repeat single PUT of it is a 409 too); the write is `put({sha256})`, so only bytes that hash to the key can be written | kept; two racing PUTs write the same bytes |
| multipart create | `orig/<sha>` | 409 `conflicting-object` if the key exists | kept |
| multipart complete | `orig/<sha>` | `head` first: 409 `conflicting-object` if the key exists, and the upload is aborted. It used to replace the key | fixed (`write-once`) |
| finalize | `orig/<sha>` | hashes the stored object; a mismatch answers 409 `digest-mismatch`, records nothing and deletes nothing. It used to delete the key, which another case's verified original could be | fixed (`write-once`) |
| import file and list | `pkg/<v>/<path>`, `rm/<v>/chronology.json` | staging versions only; `head` first, another checksum 409 | kept |
| restore step | `orig/<sha>`, `pkg/<v>/<path>`, `rm/<v>/chronology.json` | `head` first (another checksum, or a multipart object that no `original` row records with this SHA-256 and size, 409 `conflicting-object`; a recorded multipart object is accepted and not rewritten), the key, local header and archive CRC-32 of every entry in the step checked before the first of them is written, `put({sha256})`, and no delete. A stored version or another case's version is refused. It used to put unconditionally and delete the target on a CRC mismatch | fixed (`restore-guards`) |
| user-work snapshot | `backup/<case>/<label>-<rev>-<sha256>.json` | the key holds the digest of its bytes, so a repeat writes the same bytes | kept |
| export start and steps | `export/<case>/<id>/gen/…`, `export/<case>/<id>.zip` | a fresh UUID per job, written and completed only by that job | kept |
| export failure and seal | the job's `gen/` objects, its own upload | deletes and aborts only what that job created | kept |
| restore upload | `import/<uuid>.zip` | a scratch key with a fresh UUID and no D1 row; a backup of another client is deleted on `open` | kept |
| identity | `identity/client.json` | never written by the Worker | kept |
| previews | `preview/…` | no code writes it yet | unproven (GRS-118) |

Residuals. A `head` followed by a write is not atomic, and the probe does not use a conditional write. Two writers racing on one key write the same verified bytes for `orig/`; for a staging version's `pkg/` key a lost race leaves bytes that no longer match their recorded digest, which `finish` and the file route then refuse (409, 410), so a wrong byte is not served. A finalize that fails leaves its unrecorded object in place: re-uploading the same SHA-256 then answers 409 until a reaper, which the product (GRS-117) owns and this probe does not have, removes it.

**D1 tables:** [`schema.sql`](../../../tests/hosting-probe/storage/schema.sql). `storage_identity`; `batch_guard` (a guarded batch's first statement inserts NULL here when its condition fails, which rolls the batch back); `results_version` with `staging` and `stored` states and the expected counts; `package_file`, `document`, `asset` and `seed`, keyed by `(version_id, …)`; `original` and `case_original`; `active` and `activation_log`; `case_rev`, plus every `uw_*` table, which must have a `case_id` column; `export_job` and `export_entry`.

## Frozen interfaces

These are the contracts the probe proved. Product owners implement them, so GRS-117 (store), GRS-118 (assets) and the export owner do not re-derive them.

- **Identities.** A client is its deployment (`CLEARCASE_CLIENT_ID`), never a request field. A case is an opaque id (`ids.ts` `id('case', …)`). A results version is an opaque `sha256:<64 hex>` id that the importer chooses; the probe checks its format and nothing more (its own versions are digests of other strings, not of a package), and a version is immutable once `stored`. Whether the product makes it the digest of the package is GRS-117's to define and verify. An original is its SHA-256 and size. An asset id is case-scoped and binds to exactly one original: re-finalizing it with another digest is refused (409 `asset-bound-to-another-original`, `write-once`). A user-work row is `(case_id, row_id)`, with a version that changes on every write, and `case_rev` orders every write in a case.
- **Storage gate.** Each isolate reads `storage_identity` and `identity/client.json` on its first request, checks both against `CLEARCASE_CLIENT_ID`, and caches the verified client for the isolate's life: bindings cannot change under a running isolate, so a changed binding takes effect with a new isolate. It is not read on every request. A missing, empty or other-client value is 503 (`missing-identity` or `crossed-binding`, naming the binding), with nothing read or written. The other client's id is never echoed. Each `crossed-bindings` check starts a fresh workerd, so it exercises that first request.
- **Delivery.** `read(asset, range?)` hashes the whole stored object against its recorded SHA-256 and size. Up to 32 MiB (a whole original, or a range of at most 32 MiB) no byte leaves before that. Beyond it the object is read twice, the second read is hashed as it streams, and its last chunk is held until the digest matches ([what leaves, and when](#integrity-which-check-catches-what)). The answers are 410 `changed-original` or `missing-original` with no bytes, 416 for an unsatisfiable or multiple range, and 206 with `Content-Range` otherwise. A change between the two reads ends the response short of its last chunk.
- **Import.** `begin(version, expected counts, list digest)`, then `putFile`, `putList` and `rows(table, rows)` while staging, then `finish()`, which stores the version only when every count and object matches. A `begin` on a staging version deletes its rows first. `activate(version, expected)` is one guarded batch.
- **User work.** `add(fields, operationId)` is idempotent per operation and assigns `seq` inside its statement. `replace` and `remove(rowId, expected)` answer `written`, `stale` or `gone`. `snapshot()` covers every `uw_*` table. `restore(expectedRev, snapshot)` writes a pre-restore snapshot to R2 first, then runs one batch. It refuses a snapshot that lacks or adds a table, or changes a table's columns.
- **Export.** `start()` fixes the manifest (`clearcase.case-backup/1`: client, case, resultsVersion, every entry's path, kind, SHA-256 and size). `step()` writes the next 8 MiB part; a step that loses a race on the job is refused (409 `stale-step`). `seal()` hashes the backup. A download hashes it whole first, then streams a second read that is hashed again, with its last chunk held until the digest matches. Unproven, no leg exercises them: `stale-step`, and R2 refusing completion when a racing part replaced a recorded one.
- **Restore.** `open(caseId)`, `step(caseId, from)` and `finish(caseId)` each name the case; a backup of another client is 409 `wrong-client` and one of another case 409 `wrong-case`. A restore goes only into a case with no active version, with a version that is new or its own unfinished one: a live case is 409 `case-live`, a stored version 409 `already-restored`, a version of another case 409 `version-of-another-case`. `step` copies each object entry to `orig/`, `pkg/` or `rm/` write-once (409 `conflicting-object` for a key holding other bytes, 422 `crc-mismatch` before any write for an entry whose archive CRC-32 is wrong). `finish` validates the whole backup first (against the deployment's `uw_*` tables and columns too, and the results record's counts, the rows' keys and types and the objects in R2: 422 `invalid-packet`, 409 `incomplete` or `asset-bound-to-another-original`), then writes the pre-restore backup, stages the version, replaces the user work, binds the originals from allow-listed rows with the case from the request, and stores and activates the version last, in one guarded batch. Every refusal that the backup itself decides comes before the first write and leaves the case as it was; for the user work that is each `uw_*` table's PRIMARY KEY, UNIQUE and NOT NULL columns, read from the schema, with key values compared the way the column stores them (under its declared type's affinity: `1` and `"01"` are one INTEGER key, `1` and `"1"` are two keys in a column with no type). A `uw_*` table that declares a CHECK, a FOREIGN KEY, an expression or partial index, a COLLATE other than BINARY (on a column or in an index) or STRICT stops every restore with 500 `unchecked-constraint`, until the check learns it. The same refusals from `restore(expectedRev, snapshot)` answer 422 `invalid-snapshot`, and from a backup 422 `invalid-packet`. What a concurrent writer can still cause comes later. A change to the user work's revision, or an activation, before the first batch or the user-work batch is refused there (409 `stale` or `case-live`): the first leaves nothing written, the second a staging version with its rows and no active one. An activation that lands after the user-work batch, while the originals are bound, is a residual: the flip answers 409 `case-live`, the user work stays replaced (the pre-restore backup holds the old), the originals stay bound, and a retry answers 409 `case-live` as well. A refusal at the flip for a missing row leaves a staging version, and the same call can be repeated. A backup restores only into a deployment of the same client. Callers: the probe's `restore` and `restore-guards` legs are the only ones; the routes changed to take `caseId`.
- **Backup.** User-work snapshots (`clearcase.user-work/1`) in R2 under `backup/`, with their SHA-256 in the key; the probe proves the pre-restore snapshot exists with that digest, not a read of one back through a route (unproven). Whole-database recovery is D1 Time Travel (HOLD, P6).
- **Case backup and the Complete case export.** `clearcase.case-backup/1` is a recovery artifact: one case's user work (Notes included), results record, read model, package files, list and every original, and it restores. GLOSSARY.md's **Complete case export** (GRS-118) is a different download: the case's originals, published file previews and manifest, and no Notes unless explicitly selected. The backup is not that export, which is why the former name `clearcase.case-packet/1` was retired; the glossary avoids "case packet" and "backup" for the export.

## Local measurements (not budgets)

These are wall times on one host (20 threads), local workerd and Miniflare's D1 and R2 on local disk, while other worktrees ran their own gates. They are not Workers isolate figures. None of them is a budget, and none supports a latency claim.

| Measure | Local value |
| --- | ---: |
| Upload and finalize of 1,662 originals (3,211,390,882 bytes) | 60,513 ms |
| Import of one version (both attempts, plus the bound-row arm) | 5,927 ms |
| Document page: cold (first request on a fresh workerd) / warm (median of 5) | 28.2 / 3.3 ms |
| Chronology view (1.5 MB list verified and parsed): cold / warm | 8.4 / 6.5 ms |
| 64 KiB range of the largest original (258,590,305 bytes; a range of up to 32 MiB is one hashing pass over the whole object, so this is the first read alone) | 2,384 ms |
| The largest original whole (two reads, the second hashed as it streams) | 5,764 ms |
| Export build and seal | 105,853 ms |
| Offline backup check (Python) | 2,416 ms |
| Restore into the fresh deployment (upload, steps, finish) | 104,481 ms |
| Peak resident set of the workerd processes (process memory, not an isolate's 128 MB) | range leg 478,699,520 bytes; export leg 1,059,516,416 bytes |

## What stays HOLD

Each of these needs moment **M2**: Workers Paid plus R2 on an account Dian unpins, with D1 and R2 created in the EU jurisdiction. They are listed in the summary's `hold` array.

- **P1 page latency** from a South African vantage point, cold and warm isolates, and the **cold-isolate fraction** under real traffic. This decides what per-request whole-object verification costs.
- **P2 presigned-PUT burst** of about 1,700 objects through the S3 endpoint. This run uploaded through the Worker binding only.
- **P3 verification-job CPU** against the Workers CPU limit, and whether a presigned PUT can enforce a SHA-256.
- **P5 enforcement** of the per-invocation D1 query and subrequest limits. Local workerd enforces neither; the counts above are what the design stays under.
- **P6 D1 Time Travel** restore and undo, and `wrangler d1 export` duration on a 45 MB database.
- **P4 to P6 against the two-database layout arm** (results and user work in separate D1 databases). GRS-95 says choosing a layout needs P4, P5 and P6 run against both; this unit ran one, so the layout is chosen structurally, from counts, and the comparison is open.
- **Actual EU placement** of D1 and R2. Nothing here was placed anywhere: no residency claim is made.
- **Numeric load, latency and memory budgets**, which come from P1 to P3.

## Follow-ups

- Inject a corrupted entry into a backup between export and restore, so that path is shown, not only constructed. The archive CRC-32 mismatch is shown (`restore-guards`); a changed entry body under a correct central directory is refused by R2's `put({sha256})` by construction and not injected.
- Fold the v5 size profile (`generate.ts` `V5`) into GRS-144's `scripts/fixtures` `poc` profile, so one generator serves both.
- The bytes that leave before a changed delivery's last chunk (the last row of [Integrity](#integrity-which-check-catches-what)) are for the design gate: accept them, or cap whole GETs at a buffered size and serve larger originals only by range, which would make the first byte wait for the digest.
- A reaper for unrecorded `orig/` objects that failed their finalize (product, GRS-117). A refused multipart `complete` aborts its own upload; an upload a client abandons before `complete` is not reaped by the probe.
- Proxy retries are classified by response shape alone (`probe.ts` `http`): no per-request id shows the Worker never ran, and the total is not capped.
- The `json_each` chunk bound counts UTF-16 units, not bytes, so non-ASCII rows can pass remote D1's 2 MB limit that the ASCII corpus cannot show.
- `blob-arm` is not scoped to its case, and a malformed local header answers 500 where 422 is meant (`zip.ts`).
- The time a restore or export takes per step on real Workers (P3, P7 CPU) decides the step sizes (8 MiB parts, 64 MiB restore steps). The export hashes in JavaScript (about 220 MB/s under Bun) because workerd's DigestStream cannot carry its state between invocations; its CPU cost per step is part of P3.
