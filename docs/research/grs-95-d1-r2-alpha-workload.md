# GRS-95: D1 and R2 for the hosted alpha workload

Research ticket GRS-95 (wayfinder, throwaway branch). Base `8693ed886b7c641eacba76d06806f723f515cedb`. Sources were read on 14 October 2026. The text was first committed at `ccf5233695e9579cf8eb7d921914c2aca2a7d282`, together with the only measurement; a later correction commit changed prose only (see [Revision and corrections](#revision-and-corrections)). Each Cloudflare fact cites the official page and the "last updated" date the page showed. Words follow [GLOSSARY.md](../../GLOSSARY.md).

## Question

The hosted design proposes D1 for structured data and R2 for originals, immutable packages and exports, with a separate set per client. Is that pair necessary? Does it perform well enough without needless operational, query, import or export overhead? Which layout inside Cloudflare Workers' limits is the simplest one that works?

## Verdict

**Research recommendation (provisional): R2 for originals and for exports and backups; D1 for the relational read model and user work; do not rewrite the 35 datasets into tables by default. Performance: INCONCLUSIVE until the hosted proof below runs.** The user accepted D1 and R2 only provisionally, pending this research, and nothing found here contradicts that. Nothing found here proves it either.

1. **R2 holds the bytes that never change once validated, plus bulk output:**
   - the originals, keyed by sha256. At 3.21 GB for 1,662 objects (max 247 MiB) they cannot sensibly sit in D1 whatever else is decided: D1 is 500 MB on Free and 10 GB on Paid, with a 2,000,000-byte row limit;
   - export and backup files.
2. **D1 holds what the app already keeps as rows today:**
   - version and import metadata, and the activation pointer and log;
   - the per-row read model (document, asset, seed);
   - all user work;
   - the manual processing queue's job records (see [Manual processing queue](#manual-processing-queue)).
3. **The package files and the chronology list can stay in D1 or move to R2; the data supports either for the POC.** D1's limit is 2,000,000 bytes per row, string or BLOB. The real v5 chronology dataset is 1,827,097 bytes (91% of the limit) and a synthetic list at the newer export's 2,131 rows is 1,907,246 bytes (95%). Both are below the limit, so the current `package_file` BLOB layout is not ruled out at POC sizes. They leave under 10% headroom, though, and the newer export's real files are unmeasured. This note prefers R2 for them because a single file that grows past the limit would need chunking, and because R2 keeps the exact package bytes next to the originals. That preference is a design choice, not something the limit forces. The decision belongs to the design gate.
4. **Keep each dataset whole by default and do not plan a normalized rewrite, but do not treat that as proven.** Views read each dataset whole today (`datasetOf`), and normalizing 35 datasets is a large port with a migration for every schema change. The one measurement here (a Node V8 CPU proxy, about 3 ms for a whole-list parse at 2,131 rows) does not decide the question. It leaves out hosted latency, deep-freeze, per-view query costs and the cost of the D1 path (see [Measurement](#measurement)). Revisit normalization if the hosted proof or a concrete view's query shows a need.
5. **Do not use Durable Objects now.** The only concrete need is serialized, checked user-work writes, which today use an in-process queue. A D1 statement or batch can express that, and one D1 database is single-threaded. Use a DO only if hosted proof P4 fails.
6. **Add no other services by default.** The 24 to 36 hour manual queue is durable job metadata with claim, reentry, priority and paused-client states. It is not a Cloudflare Queues message held for 24 to 36 hours, and the plan-dependent Queues retention does not enter the decision. Add Cloudflare Queues only if delivery events or background jobs, such as verifying originals after upload, turn out to need it.
7. **The integrity change is not accepted.** Replacing verify-on-load with import-time checks, write-once keys and ETag guards weakens or alters the GRS-12 contract in ways no one has analysed. It needs a threat and failure analysis and the user's decision. See [Integrity](#integrity).
8. **Two layout questions are open, not settled:** one combined D1 database per client or separate results and user-work databases (see [Database layout](#database-layout-open)), and how a full case export becomes a complete downloadable packet (see [Exports](#exports)).

The verdict is a design recommendation from source, documentation and a CPU proxy. It is not hosted performance evidence. The latency numbers that decide page speed exist only after the hosted proof below.

## Constraints taken as given

- A SvelteKit Worker app, built and developed with Bun, in one user-controlled Cloudflare account.
- Per client: its own Worker, D1 database, R2 bucket(s), secrets and Clerk app.
- One or two firms at first, with POC sizes: v5 has 1,689 documents and the newer export has 2,131.
- Low idle cost, with bursts at initial upload and at export.
- Background jobs, and a manual processing queue whose turnaround is about 24 to 36 hours. The queue is business workflow state, not a message-retention requirement.
- An EU storage fallback is acceptable. Amounts are displayed in ZAR.

## What the app stores and reads today (source)

Storage is two `node:sqlite` files (`src/lib/local-case/db.server.ts:21-91`):

- `results.sqlite` holds immutable results:
  - `version`, including `overview` and the whole `chronology_json` list in one column;
  - `package_file`, the exact package bytes as BLOBs;
  - the read model: `document`, `asset` and `seed`;
  - `import_attempt` and `retired_version`.
- `work.sqlite` holds precious state:
  - `active` and `activation_log`, plus `trusted_warning`;
  - user work in `note`, `seed_overlay` and `register_row`, and in tables M2 views add through `defineTable`.

`node:sqlite` is a non-functional stub in Workers (Workers Node.js compatibility page, updated 12 Aug 2026), and the case folder is a local directory. A hosted port therefore rewrites `db.server.ts`, `store.server.ts`, `originals.server.ts` and the case-folder parts of `service.server.ts` whatever storage is chosen. The package library (`src/lib/case-package/`) and the views' read contracts (`datasetOf`, `documentRows`, `listJson`) can stay.

Hot paths, read from source before measuring:

| Path | What it does now | Hosted consequence |
| --- | --- | --- |
| Every `/v/[vid]` page and the chronology API | `a.verify(v.id)` (`+layout.server.ts:16`, `api/v/[vid]/chronology/+server.ts:14`). This re-reads every package byte and every read-model row, re-hashes them and recomputes the digest, cached per process (`service.server.ts:168`). | Today the cache lives per process. A Worker isolate has its own memory and can be evicted, so each new isolate would repeat the check unless it is changed. How often that happens is not known: the cold-isolate rate was not measured and depends on traffic and Cloudflare's scheduling. Proxy cost per run: 5.4 ms of Node V8 CPU for the SHA-256 alone, plus reading all 37 package files (not measured hosted). Whether to replace it is an open decision (see [Integrity](#integrity)). |
| Most views | `datasetOf` reads one whole dataset, then parses and deep-freezes it, cached per process with at most 64 entries (`results.server.ts:11,20`). Each view reads `view-content` plus one or two datasets. | One R2 GET per dataset per isolate that has not cached it, then one parse and deep-freeze. The cache must be bounded by bytes, not entry count, under 128 MB of isolate memory. |
| Evidence views and search | Parse the whole list once per ETag and filter in memory (`views/evidence/rows.server.ts:14,35`). Search does not search full text. | One R2 GET of the list (about 1.5 to 1.9 MB) and a whole-list parse (2 to 3 ms in the Node V8 proxy, which excludes deep-freeze). The hosted cost is unmeasured. No D1 full-text search is needed for parity. |
| Document page | `documentRow(store, rv, ref)` is one row by primary key (`store.server.ts:237`). | One indexed D1 read. |
| Register writes | An in-process queue per (case, store), with `exclusive()` for restore (`registers.server.ts:2-12`), and every write in `BEGIN IMMEDIATE` (`db.server.ts:242-252`). | The queue does not serialize across isolates, and D1 has no interactive transactions. Each check-and-write must become one statement or one guarded batch (see Transactions). |
| Backups | `VACUUM work INTO` after each activation (`store.server.ts:205`), plus `exportAll`/`importAll` snapshots. | Use D1 Time Travel for disaster recovery and `exportAll` snapshots in R2 for per-case restore. |

## Workload, measured as aggregates only

A local script (`.local/grs-95/aggregate.ts`, ignored, not committed) converted the local v5 sample into an ignored directory and imported it into a throwaway store. It printed only byte and row counts keyed by dataset key, column and MIME type. It printed no paths, refs, names or values.

| Quantity | v5 (1,689 documents) |
| --- | --: |
| Package | 37 files, 6,249,551 bytes |
| Largest package files | chronology 1,827,097; bundles 1,613,368; caselines-index 1,188,230; assets.json 798,849 bytes; all others under 333 KB |
| `version.chronology_json` (the list) | 1,509,878 bytes (894 bytes per row) |
| `document` row (row + state + attachments JSON) | p50 1,287, p99 3,093, max 4,617 bytes; 2,342,785 in total |
| `asset` rows / `seed` rows | 3,054 (1,746 files, 1,308 embedded) / 7 |
| Unique referenced originals | 1,662 objects, 3,211,390,882 bytes: p50 205 KiB, p90 1.1 MiB, p99 31.5 MiB, max 246.6 MiB (258,590,305 bytes) |
| Originals over 32 MiB / over 100 MiB | 17 / 7 |
| By type (bytes) | PDF 2.32 GB (1,161), RFC 822 e-mail 0.83 GB (467), Outlook MSG 78 MB (89), other 13 MB |
| `results.sqlite` for one version | 16.2 MB (includes the 6.25 MB of package BLOBs and the list) |
| Import into the local store | 2.0 s (one run, local disk; context only) |

The 3.21 GB includes the 57 package files GRS-45 added, such as the bundle PDFs. That is why it exceeds the 1.85 GB that `results-package.md` records for the original register. No aggregate exists yet for the 2,131-document export. Where this page scales by document count, it says so; it does not treat that scaling as measured.

## Platform facts that decide the layout

| Fact | Value | Source |
| --- | --- | --- |
| D1 row, string or BLOB | 2,000,000 bytes, Free and Paid | D1 limits (21 Apr 2026) |
| D1 database size | 500 MB on Free; 10 GB on Paid, not raisable | D1 limits |
| D1 statement length / bound parameters / query duration | 100 KB / 100 / 30 s, and the 30 s covers a whole batch | D1 limits |
| D1 queries per Worker invocation / connections | 50 on Free, 1,000 on Paid / 6 | D1 limits |
| D1 throughput | One database is single-threaded: at a 1 ms query, about 1,000 queries per second | D1 limits |
| D1 transactions | `batch()` statements run sequentially as one SQL transaction and roll back on failure. D1 is auto-commit, and the Worker API offers no interactive transaction. | D1 Worker API (22 Jun 2026) |
| D1 Time Travel | Restores any minute in the last 30 days (7 on Free) and overwrites the whole database in place. Each restore returns an undo bookmark. No charge. In-flight queries fail. | Time Travel (21 Apr 2026) |
| D1 export | `wrangler d1 export` blocks other requests while it runs, and it does not support virtual tables, so FTS5 tables block it | Import and export (21 Apr 2026) |
| D1 location | Jurisdiction `eu`, `fedramp` or `us` is set at creation and cannot be changed later. Location hints exist only for `wnam`, `enam`, `weur`, `eeur`, `apac` and `oc`. D1 does not run in `afr`. | D1 data location (2 Oct 2026) |
| D1 read replication | Opt-in, needs the Sessions API, no extra cost. Latency depends on distance to the primary. | Read replication (10 Aug 2026) |
| R2 objects | Up to 5 GiB in one PUT. Multipart parts are 5 MiB to 5 GiB, at most 10,000. Incomplete multipart uploads are aborted after 7 days. | R2 limits (8 Jun 2026); multipart (29 Jul 2026) |
| R2 writes to one key | 1 per second; more returns 429 | R2 limits |
| R2 jurisdiction | `eu` set at creation, never changed. The Worker binding must name the jurisdiction. The EU S3 endpoint is `<account>.eu.r2.cloudflarestorage.com`. | R2 data location (19 Aug 2026) |
| R2 presigned URLs | GET, HEAD, PUT and DELETE. Expiry 1 s to 7 days. Only on the S3 endpoint, not on custom domains. Browser use needs CORS. Content-Type can be bound into the signature. | Presigned URLs (22 Aug 2026) |
| R2 Worker API | `get()` takes `range` and `onlyIf` (etag) and returns a stream. `put()` takes `sha256`, an integrity check the upload must match. | Workers API reference (31 Jul 2026) |
| Worker request body | 100 MB on Free and Pro, 200 MB on Business, more on Enterprise. This is set by the account's Cloudflare plan. | Workers limits (12 Oct 2026) |
| Worker memory / CPU | 128 MB per isolate. CPU: 10 ms per request on Free; 30 s by default and up to 5 min on Paid. | Workers limits |
| Cache API | Per data centre, not replicated. Works on custom domains; the page does not say it works on workers.dev. Refuses `no-store` responses. | Cache API (14 Aug 2026) |
| Hashing a stream | `crypto.DigestStream("SHA-256")` hashes a stream without holding it in memory | Web Crypto (30 Sep 2026) |
| Smart Placement | Needs consistent traffic from several locations. Affects only `fetch` handlers. A `placement.region` hint is the alternative. | Placement (12 Oct 2026) |
| Queues (relevant only if background jobs use them; the manual queue does not) | 128 KB messages, delays up to 24 h, retention up to 14 days on Paid and a fixed 24 h on Free. A consumer gets 15 min of wall time and up to 5 min of CPU. | Queues limits (21 Apr 2026) |

## Options compared

| | A. Whole payloads in R2, small metadata and user work in D1 | B. Datasets normalized into D1 tables, blobs in R2 | C. A plus the existing row read model in D1 (recommended) | D. Durable Object SQLite per case |
| --- | --- | --- | --- | --- |
| Fits D1's 2 MB value limit | yes (package files in R2) | yes, if every row is small | yes: largest document row 4.6 KB; package files in R2 or, at POC sizes, D1 | DOs have the same 2 MB limit |
| Document page by ref | needs the whole list or a per-document object | indexed | indexed (`document` primary key) | indexed |
| View reads | one R2 GET plus a parse | a SQL query per view, written per dataset | one R2 GET plus a parse, as today | as B or C |
| Import writes | 37 R2 PUTs | 37 PUTs plus every record of 35 datasets as rows | 37 PUTs plus about 4,750 rows (document, asset, seed) | as C, inside the DO |
| Schema churn | none | a migration for every dataset schema change | as today's read model | as C, migrated per object |
| Export and backup | R2 copy; D1 export is small | large D1 export, which blocks requests | R2 copy, plus a D1 export of the small read model and user work | no `wrangler d1` tooling; a custom export |
| New code | a document lookup over R2 (new) | a projector for 35 datasets (large) | a port of the existing projector | port plus DO routing and lifecycle |

A is close to C, but C keeps the read model GRS-12 already tests, and it gives the document page, asset lookup and anchor matching (`store.server.ts:237-263`) indexed queries for a few thousand rows per version. B adds the largest amount of code and migration surface, and no view has yet been shown to need it. B is therefore the option to revisit if a hosted proof or a concrete view query shows a need, not one this note has shown to be unnecessary. D is justified only if the user-work invariants cannot be kept with D1 batches (proof P4).

## Proposed minimal layout (per client)

Provision once per client with no shared state: one Worker (SvelteKit, `adapter-cloudflare`), D1 (one database or two; see [Database layout](#database-layout-open)), one R2 bucket, the secrets and one Clerk app. Choose the jurisdiction before creation (`eu` for the EU fallback), because D1 and R2 cannot change it later.

**R2 keys** (write-once by app policy; see [Integrity](#integrity)):

```
orig/<sha256>                         original bytes, content-addressed (dedupes shared sha256)
pkg/<resultsVersion>/<path>           exact validated package files: manifest.json, assets.json, datasets/<key>.json (preferred; D1 BLOBs also fit at POC sizes)
rm/<resultsVersion>/chronology.json   the list served by /api/v/[vid]/chronology (today version.chronology_json; same choice)
backup/<caseId>/<iso-time>.json       exportAll() user-work snapshots
export/<caseId>/<iso-time>/...        export files produced by jobs
```

**D1 tables:** today's schema, minus the two large columns if the package files and list go to R2 (otherwise unchanged):

- `version` without `chronology_json`, but with `list_etag` (the list's R2 ETag) and a `state` of `staging` or `stored`;
- `import_attempt` and `retired_version`;
- `document`, `asset` and `seed`, unchanged, keyed by `(version_id, …)`;
- `active`, `activation_log` and `trusted_warning`;
- `note`, `seed_overlay`, `register_row`, `userwork_catalog` and the tables M2 views define;
- the manual processing queue's job records (see [Manual processing queue](#manual-processing-queue));
- `package_file`, kept with `sha256`, `size` and, if the bytes move to R2, the R2 `etag` per file but no `bytes`.

That is about 8.5 MB of D1 per v5 version with the package and list in R2: the 16.2 MB store less the 6.25 MB package and the 1.51 MB list (an estimate). Keeping one active, one previous and three candidates per case puts a database at about 45 MB, or about 80 MB if the package files stay in D1. Both are inside the 500 MB Free and 10 GB Paid limits.

**Upload and import** (initial burst):

1. **Originals.** The browser PUTs each original straight to R2 with a presigned URL on the S3 endpoint. This bypasses the Worker's 100 MB body limit, which 7 v5 originals exceed. The largest original (247 MiB) still fits one PUT, under the 5 GiB limit. The key is `orig/<sha256>`, so a repeat upload is a no-op (check with HEAD first).
2. **Package.** The package (6.25 MB) is posted through the Worker. The Worker validates it with the existing library and writes the 37 files to `pkg/…` with `put(…, {sha256})`.
3. **Verification job.** A background job streams each referenced `orig/<sha256>` through `DigestStream` and checks sha256 and size. This replaces the hash of the case folder. A Queues consumer is one candidate runner, not a decision. Whether to re-hash, or to trust a checksum R2 enforced at upload, is open (proof P3 and [Integrity](#integrity)).
4. **Read model.** The projector writes about 4,750 rows. A statement holds at most 100 bound parameters, so with 6 columns that is 16 rows per statement and about 300 statements. Those statements need several batches, and several batches are not one transaction. The rows are therefore written as `staging` under their content-addressed `version_id`. A final batch flips the version to `stored` only after it checks the row counts. A crashed import leaves staging rows that the next attempt deletes and rewrites, so the import can be repeated safely.

**Reads.**

- A page reads the D1 rows it needs in one `batch()`: the version, the active pointer and the user work. In parallel it reads R2 objects (`view-content` and the view's datasets).
- Parsed datasets go in an isolate cache keyed by `resultsVersion` and bounded by bytes. The data is immutable, so the cache never needs invalidation.
- The Cache API can hold immutable `pkg/` and `rm/` responses only behind a custom domain, under keys that never leave the client's own hostname. It is optional, because the cache is per data centre.

### Integrity

**Status: the proposed change is not accepted.** GRS-12's rule is "verify each version when first served by a process". Moving it to Workers changes what each check costs, but nobody has yet shown that a cheaper check protects against the same failures. This note therefore does not weaken the contract. Until the user accepts a replacement, the contract stays as GRS-12 states it, and the hosted cost of that check is something to measure (P1, P8).

What the candidate checks do and do not give:

- **Write-once keys are an app policy.** The app can choose never to overwrite a key. Content-addressed naming (`orig/<sha256>`) does not make R2 enforce immutability: any writer holding credentials can replace the object under that name, and the name only matches the content if someone verified it at write time. Whether R2 offers server-side immutability (for example bucket locks) was not researched here.
- **An ETag check is not a SHA-256 verification.** An `onlyIf: {etagMatches}` GET against a stored ETag detects that the object differs from the one recorded, and it costs nothing extra on a GET already made. It does not recompute the content hash, and this note did not establish what the ETag covers for each upload path (single PUT, multipart, presigned). It can be an additional guard, but it is not independently sufficient to claim the prior integrity contract is preserved.
- **Verification at import and activation**, as today, covers bytes at that time only.

Required before any replacement is proposed for acceptance:

1. A threat and failure list: storage corruption, accidental overwrite, a partial or interrupted import, a wrong object served, a credential-holder replacing an object, a restore from backup. For each one, which check detects it and when.
2. A failure-injection test on the hosted stack (P8): corrupt or replace objects under `pkg/` and `orig/` and show which check catches each case.
3. The measured hosted cost of keeping the GRS-12 rule (hash on first serve per isolate), against the unmeasured cold-isolate rate (P1).
4. The user's decision at the design gate. A weaker rule is adopted only by that decision, not by default.

**Activation and rollback** each become one D1 batch: a guard, the `active` upsert and the `activation_log` insert. A rollback points `active` at an older stored version. User work is keyed by case and anchor, so it is never touched.

### Exports

- View CSV exports stay small and Worker-generated.
- **Scope requirement carried forward:** a full case export is a complete, self-contained, downloadable packet, not a set of pointers into the live system.
- **A manifest of expiring presigned links is not proven equivalent to that packet.** Presigned GET links expire (1 second to 7 days), work only while the bucket and credentials stay in place, and leave the user with dozens to thousands of separate downloads. They can serve as an interim index or a supplement to a packet. They do not by themselves meet the requirement, and this note does not claim they do.
- **Not yet shown:** how an actual ZIP (or PDF) of a case, up to several GB of originals plus the package files and a user-work snapshot, is generated on Cloudflare, and that it can be recovered from. A Worker has 128 MB of memory and CPU limits, so a naive in-memory zip is out. Whether a streaming store-only zip, a background job, or something else works was not tested. R2 egress is free, but producing the archive is the open part.
- Proof P7 covers this: generate a synthetic packet at v5 size, then open it offline and restore the case from it.

### Database layout (open)

Today's app keeps two stores, `results.sqlite` and `work.sqlite`. The first layout in this note, one combined D1 database per client, was a default, not an approved choice. The user's provisional answer that results and user work be stored separately settles the logical separation. It does not settle whether that means two D1 databases, one database with separate tables, or something else.

A minimal comparison from D1's documented behaviour (no hosted test):

| | One D1 database per client | Two D1 databases per client (results, user work) |
| --- | --- | --- |
| Atomic batch across results and user work | yes, within one `batch()` | no: `batch()` is per database. Activation touches `active` (user-work side today) and the version state (results side), so the two writes cannot share one transaction |
| Time Travel restore | restores the whole database in place, so restoring the results also rolls back user work | restore each independently, so a results restore does not touch user work |
| Write contention | import writes and user-work writes share one single-threaded database | import writes do not queue behind user-work writes |
| Bindings and migrations | one | two sets, as the app has two files today |
| Port effort from `db.server.ts` | merge the two schemas | keep today's split |

Neither is shown to be better. The Time Travel point and the cross-database atomicity point pull in opposite directions, so choosing needs P4, P5 and P6 run against both layouts. The rest of this note holds for either.

### Manual processing queue

The manual queue (a case waits about 24 to 36 hours for manual processing) is business workflow state. It needs durable job metadata, which belongs with the app's other rows in D1, with at least:

- states for claim, reentry, priority and paused client;
- the original `submittedAt`, kept unchanged through every state change;
- a job that lacks its password rejoins the end of the queue when it becomes ready, keeping its original `submittedAt`. The queue order key is therefore not `submittedAt`;
- an SLA metric: deferred, not designed here.

A Cloudflare Queues message is not this record. Queues carry delivery events for consumers. They are a poor fit for holding a case for 24 to 36 hours, for reordering it, or for claiming and pausing it per client. Use Cloudflare Queues for background work only if that work needs delivery semantics, such as retries for verifying originals after upload. The plan-dependent Queues retention limit is not a requirement here.

## Transactional boundaries

| Operation | Today | D1 equivalent |
| --- | --- | --- |
| Store a candidate | one `BEGIN IMMEDIATE` | staging rows across batches, then one batch that flips to `stored` |
| Activation and rollback | one transaction, then `VACUUM INTO` | one batch: a guard, the pointer and the log, if `active` and the version state share a database (see [Database layout](#database-layout-open)). Time Travel plus an R2 snapshot replace `VACUUM INTO`; a combined database's Time Travel restore also rolls back user work. |
| Register add | in-process queue, then insert with the next `seq`, which lives inside `fields` (`registers.server.ts:71-72,152`) | one `INSERT … SELECT json_set(?, '$.seq', coalesce(max(json_extract(fields, '$.seq')), 0) + 1) FROM register_row WHERE case_id=? AND store=?` statement (a statement is atomic) |
| Register replace or remove with a version check | queue, re-check, write; the version is a hash of the stored fields (`registers.server.ts:5`) | `UPDATE/DELETE … WHERE row_id=? AND <stored-fields hash>=?`. Zero changed rows means `stale` or `gone` (a second read tells which). |
| Restore (`importAll`) and the `exclusive()` hold | queue-wide hold, checks, one transaction | checks against a per-case `rev`, then one batch whose first statement fails on a NOT NULL constraint when `rev` moved: `UPDATE case_rev SET rev = CASE WHEN rev=? THEN rev+1 END`. A failing statement rolls the batch back. Snapshots above about 1,000 statements per invocation need staging tables. |

## Costs (official prices, explicit assumptions, no total)

Cloudflare bills in USD. Show ZAR only as a conversion at a stated date and rate. The free allowances below are per account, so all clients share them.

| Item | Price (source) | Quantity per client, with assumptions | Against the allowance |
| --- | --- | --- | --- |
| Workers Paid | $5 per month minimum per account. Includes 10M requests and 30M CPU ms, then $0.30 per M requests and $0.02 per M CPU ms. (Workers pricing, 2 Oct 2026) | Likely needed: Free allows 10 ms of CPU per request, and the verification and import paths probably exceed it (the proxy puts a 6.25 MB SHA-256 at 5.4 ms alone; the hosted CPU is unmeasured). Assume 10 users × 300 page views a day: about 90k requests a month. | far inside |
| R2 Standard storage | $0.015 per GB-month; 10 GB-month free (R2 pricing, 1 Oct 2026) | 3.21 GB (v5 measured); about 4.05 GB scaled to 2,131 documents (estimate); 6.25 MB per package version | two clients at v5 size fit in the free 10 GB; a third, or larger cases, exceed it |
| R2 Class A | $4.50 per M; 1M free | about 1,700 PUTs per initial upload (1,662 originals and 37 package files); multipart is needed only above 5 GiB (none at v5) | far inside |
| R2 Class B | $0.36 per M; 10M free | about 1 to 3 GETs per page view on an isolate-cache miss, 1 per original opened, and 1 per range request (pdf.js range loading of large PDFs multiplies this) | inside at the assumed traffic |
| R2 egress | free from the Workers API, S3 API or r2.dev | exports and originals | n/a |
| R2 Infrequent Access | $0.01 per GB-month, $0.01 per GB retrieved, a 30-day minimum, and no free tier | do not use for originals that are opened | n/a |
| D1 storage | $0.75 per GB-month above 5 GB included (D1 pricing, 21 Apr 2026) | about 45 MB per case (estimate above) | far inside |
| D1 rows read | 25B per month included, then $0.001 per M | about 1 row per document page; a full scan of the list (about 2,131 rows) only if a view queries D1 instead of the R2 list | far inside |
| D1 rows written | 50M per month included, then $1.00 per M; indexed columns add writes | about 4,750 rows (plus index writes) per import, then user-work edits | far inside |
| Queues (only if background jobs use them) | 1M operations per month included, then $0.40 per M; one operation per 64 KB written, read or deleted (Queues pricing, 21 Apr 2026) | about 3 operations per verification message; at most 1,662 originals per import | far inside |
| Durable Objects | not used | | |

Idle cost is the $5 per month account minimum, plus R2 storage above 10 GB-month and D1 storage above 5 GB, neither reached at POC size. The bursts are Class A PUTs and verification CPU at upload, and Class B GETs at export. Both are small against the included amounts.

## Measurement

**What this is:** a Node V8 synthetic CPU proxy. It is not a Cloudflare Workers measurement and not a comparison of architectures.

**Question asked:** how much CPU does Node's V8 spend to decode and parse a whole synthetic list of the real mean row size, against parsing 50 row strings, and to hash a package-sized buffer?

| | |
| --- | --- |
| Revision | base `8693ed8`; the harness is `docs/research/grs-95-bench.mjs` (sha256 `e5fbc202…5862ad344`), committed at `ccf5233` and unchanged by the correction commit. Receipt: `.local/agent-receipts/20261014T190432.534219Z-grs-95-bench/receipt.json`. |
| Data | Synthetic rows with `ChronologyListRow`'s shape, sized to the real mean of 894 bytes per row. The synthetic list was 1,511,656 bytes, against 1,509,878 for the real one. The 6,249,551-byte package buffer is synthetic too. |
| Arms | A: UTF-8 decode, `JSON.parse` of the whole list, filter, then one 50-row page serialized. B: `JSON.parse` of 50 row strings, as D1 would return them. V: SHA-256 of the package, as verify-on-load does. |
| Sample | One fresh `node` process (V8, Node 26.10.0) per sample, to approximate a cold start. One discarded warm-up round, then 7 rounds. The arm order reverses every round. 20 cores, load average 0.06. |
| Correctness | Every sample checks the parsed row count, the filter hit count (computed independently), the page length and the digest length. Failures: 0 of 70. |

| Arm and rows | Median ms (range) |
| --- | --: |
| A 1,689 | 1.87 (1.83–1.91) |
| A 2,131 | 2.97 (2.84–3.04) |
| A 16,890 (10 × v5) | 18.73 (18.37–19.39) |
| B 50-row page (any size) | 0.11–0.13 (0.10–0.14) |
| V SHA-256 of 6.25 MB | 5.44 (5.25–8.83) |

- **Limiter:** `JSON.parse` on one core. An unreported split at 2,131 rows put about 75% of the time in parse, 22% in UTF-8 decode and 7% in the filter. The cost is roughly linear in bytes.
- **What it supports:** in Node V8 on this machine, parsing a synthetic whole list of 1,689 to 2,131 rows takes about 2 to 3 ms and grows roughly in line with its size. A SHA-256 over 6.25 MB takes about 5 ms.
- **What it does not support:** Workers CPU or latency; any ranking of options A to D; the conclusion that normalizing the datasets is unnecessary or that it is necessary.
- **Why it cannot rank the options:**
  - It omits hosted latency: R2 and D1 network round trips, from South Africa or elsewhere, dominate a page and are not in it.
  - It omits deep-freeze, which `datasetOf` does after parsing.
  - It omits any workload-specific query cost: what a normalized view would actually run (joins, filters, sorts, pagination, index maintenance), and the D1 time per query.
  - The A and B arms have unequal scopes. A decodes, parses, filters and serializes a whole list. B parses 50 pre-split row strings and does no database work, no filter and no sort. The 0.11 ms is not the cost of the D1 path.
  - It ran on Node, not workerd, with no isolate reuse and no Worker CPU accounting.
- **Not measured:** R2 and D1 network latency, workerd itself, isolate reuse, cold-isolate frequency, Worker CPU accounting. A local emulator cannot prove hosted latency, so none was used.
- **Heap:** heap deltas were unreliable because of garbage collection and are not reported.
- **Kept as is:** the proxy was not rerun for the correction. Only its description changed.

## Uncertainties

- **Latency from South Africa.** If users are in South Africa, the D1 primary and the R2 bucket sit in Europe either way: `afr` is not a D1 location, and the EU jurisdiction forces Europe. Each sequential D1 query or R2 GET from a Worker running near the user then costs a round trip to Europe. No official latency figure exists. Placement, either Smart Placement (which needs traffic from several locations) or a region hint, may move the Worker next to the data instead. Proof P1 measures this.
- **Cold-isolate rate.** How often a request lands on an isolate that has not cached a dataset or run a verification is unmeasured. It decides whether per-isolate costs (verification, dataset GET and parse) matter per request or rarely. P1 should record it under realistic traffic.
- **Integrity contract.** Which checks replace GRS-12's verify-on-first-serve, and whether they protect against the same failures, is undecided (see [Integrity](#integrity)).
- **Export packet.** Generation and recovery of a complete self-contained ZIP or PDF case packet are unproven (see [Exports](#exports)).
- **Database layout.** One combined D1 database or two is undecided (see [Database layout](#database-layout-open)).
- **R2 checksums on presigned PUTs.** The docs do not say whether a presigned S3 PUT can bind or enforce a SHA-256 checksum, as `put({sha256})` does through the binding. The answer decides between re-hashing every original and trusting the upload.
- **The guard pattern.** The NOT NULL guard that aborts a D1 batch is standard SQLite behaviour. Its surfacing through D1's `batch()` has not been tried on the hosted service.
- **The newer export's size.** The 2,131-document figures are scaled by document count, not measured. Its new datasets (`emails`, `whatsapp`, and others) may add large residual files. Any single file near 2 MB still belongs in R2.
- **Full-text search.** A later full-text search over extracted text would need FTS5 or another index. FTS5 is a virtual table, so `wrangler d1 export` would stop working on that database (export does not support virtual tables).
- **Account plan.** The account's Cloudflare plan, not the Workers plan, sets the 100 MB request body limit. Presigned uploads avoid it, but any route that proxies an upload stays bound by it.

## Hosted proof needed before the design gate

Use a throwaway client set (Worker, D1 and R2 in the chosen jurisdiction) with synthetic data only:

- **P1 Page latency.** From a South African vantage point, p50 and p95 over at least 5 alternating samples per arm. One `batch()` plus 2 parallel R2 GETs of 0.01 to 1.9 MB, cold and warm isolates, with default placement, then Smart Placement or a region hint. Include a normalized-view arm with a realistic query (not a pre-split row set) and the deep-freeze cost, so that A, B and C can be compared. Record the cold-isolate fraction under realistic traffic.
- **P2 Upload burst.** About 1,700 synthetic objects with v5's size distribution (p50 205 KiB, max 247 MiB) through presigned PUTs. Record wall time, failures and 429s.
- **P3 Verification job.** A background job (a Queues consumer is one candidate) streams 3.2 GB of synthetic originals through `DigestStream`. Record CPU per invocation against the 5-minute cap, wall time, and retries. Also test whether a presigned PUT can enforce a sha256.
- **P4 User-work invariants.** Concurrent register adds, versioned replaces and a restore through the batch guard. Show no lost or duplicate `seq`, `stale` on a raced write, and a restore that rolls back whole.
- **P5 Import rows.** Staging and flipping about 4,750 rows. Record the batches needed against 1,000 queries per invocation and 30 s per batch, and an interrupted import that recovers.
- **P6 Recovery.** A D1 Time Travel restore and its undo, plus a `wrangler d1 export` of a 45 MB database. Record export duration, since it blocks requests. Run P4 to P6 against both the combined and the two-database layout.
- **P7 Export packet.** Generate a complete case packet (ZIP or PDF) from synthetic data at v5 size and distribution. Record memory, CPU, wall time and failures. Then open it offline and restore the case from it. Presigned links alone do not count.
- **P8 Integrity failure injection.** Corrupt, truncate and replace objects under `pkg/` and `orig/`, interrupt an import, and restore from backup. Show which check catches each case, and what GRS-12's first-serve verification costs hosted.

## Revision and corrections

- **Measurement revision:** the harness and the only measurement are as committed at `ccf5233695e9579cf8eb7d921914c2aca2a7d282` on base `8693ed886b7c641eacba76d06806f723f515cedb`. Method: fresh Node 26.10.0 process per sample, one warm-up round, 7 alternating rounds, 0 of 70 failures. `docs/research/grs-95-bench.mjs` is unchanged by the correction (sha256 `e5fbc202…5862ad344`), so the numbers stand and were not rerun.
- **Correction commit:** a later commit on this branch revises prose only, after review. It softens the byte-limit conclusion, removes the Queues-retention rationale, relabels the measurement, withdraws the integrity replacement as unaccepted, reopens the export and database-layout choices, and adds proofs P7 and P8. The corrected research HEAD is recorded in `.local/grs-95-research-report.md`.
- **Still unproven (hosted):** page latency and placement, cold-isolate rate, upload burst, verification job CPU, user-work invariants, import staging, recovery, export packet generation and recovery, integrity failure behaviour, and the physical D1 layout.

## Sources

- Cloudflare D1 limits, <https://developers.cloudflare.com/d1/platform/limits/> (21 Apr 2026)
- Cloudflare D1 pricing, <https://developers.cloudflare.com/d1/platform/pricing/> (21 Apr 2026)
- Cloudflare D1 Worker API, <https://developers.cloudflare.com/d1/worker-api/d1-database/> (22 Jun 2026)
- Cloudflare D1 Time Travel, <https://developers.cloudflare.com/d1/reference/time-travel/> (21 Apr 2026)
- Cloudflare D1 import and export, <https://developers.cloudflare.com/d1/best-practices/import-export-data/> (21 Apr 2026)
- Cloudflare D1 data location, <https://developers.cloudflare.com/d1/configuration/data-location/> (2 Oct 2026)
- Cloudflare D1 read replication, <https://developers.cloudflare.com/d1/best-practices/read-replication/> (10 Aug 2026)
- Cloudflare R2 pricing, <https://developers.cloudflare.com/r2/pricing/> (1 Oct 2026)
- Cloudflare R2 limits, <https://developers.cloudflare.com/r2/platform/limits/> (8 Jun 2026)
- Cloudflare R2 multipart, <https://developers.cloudflare.com/r2/objects/multipart-objects/> (29 Jul 2026)
- Cloudflare R2 data location, <https://developers.cloudflare.com/r2/reference/data-location/> (19 Aug 2026)
- Cloudflare R2 presigned URLs, <https://developers.cloudflare.com/r2/api/s3/presigned-urls/> (22 Aug 2026)
- Cloudflare R2 Workers API, <https://developers.cloudflare.com/r2/api/workers/workers-api-reference/> (31 Jul 2026)
- Cloudflare Workers limits, <https://developers.cloudflare.com/workers/platform/limits/> (12 Oct 2026)
- Cloudflare Workers pricing, including Durable Objects and Queues, <https://developers.cloudflare.com/workers/platform/pricing/> (2 Oct 2026)
- Cloudflare Workers Cache API, <https://developers.cloudflare.com/workers/runtime-apis/cache/> (14 Aug 2026)
- Cloudflare Web Crypto (`DigestStream`), <https://developers.cloudflare.com/workers/runtime-apis/web-crypto/> (30 Sep 2026)
- Cloudflare Workers placement, <https://developers.cloudflare.com/workers/configuration/placement/> (12 Oct 2026)
- Cloudflare Workers Node.js compatibility, <https://developers.cloudflare.com/workers/runtime-apis/nodejs/> (12 Aug 2026)
- Cloudflare Durable Objects limits, <https://developers.cloudflare.com/durable-objects/platform/limits/> (1 Jun 2026)
- Cloudflare Queues limits and pricing, <https://developers.cloudflare.com/queues/platform/limits/>, <https://developers.cloudflare.com/queues/platform/pricing/> (21 Apr 2026)
- Repository at `8693ed8`: `docs/results-package.md`, `docs/development.md`, `src/lib/local-case/{db,store,service,results,registers}.server.ts`, `src/lib/views/evidence/rows.server.ts`, `src/routes/v/[vid]/+layout.server.ts`, `src/routes/api/v/[vid]/chronology/+server.ts`
