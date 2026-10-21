# Recovery proof: the local workerd legs (GRS-110)

[GRS-110](https://linear.app/vaper/issue/GRS-110) asks for a tested recovery design that keeps acknowledged originals and ordinary rollback user work, and that defines deletion and backup behaviour. Cloudflare stays pinned (GRS-26, 17 and 20 October 2026), so this unit runs only the legs that can pass on native workerd with local D1 and R2 and no Cloudflare account. The cloud legs' owner (GitHub `dianbrown`) holds the unpin and the legs at moment M2.

**Verdict at 6bd0a77a: PASS for the local legs; HOLD for the cloud legs.** Every leg below passed at `6bd0a77aa1fe80d71d2e1300e3d8f9143e6c09aa` (exit 0, `evidence: true`, 1,203 mutations of its summary refused, 0 dev-proxy retries). This is the fix round after the first review (`bfd9e088`), which found that removal left staged packets behind (H1), that a running isolate could serve a removed case (M1) and that nothing verified the evidence binding (M2). The three legs that stay HOLD, and the moment each needs, are [at the end](#what-stays-hold). Like GRS-109's, this probe is a model of the design, not the product: GRS-117 and the owners in [the handoff](#product-and-runbook-handoff) implement it.

## Run it

From `tests/hosting-probe/recovery/`. It has no dependencies of its own: it runs Wrangler, workerd and Miniflare from the storage probe's install at GRS-109's pins.

```sh
(cd ../storage && bun install --frozen-lockfile)   # once, online
bun run --bun probe                                # about 45 s; writes .local/hosting-probe/recovery/summary.json at the repo root
bun run --bun probe --check FILE                   # exit 0 only for this runner's PASS summary whose sourceSha is HEAD, or an ancestor of it with only this page and the summary changed since
bun run --bun test:check                           # the committed summary passes --check; a made-up sourceSha and every mutation of it are refused
```

[`probe.ts`](../../../tests/hosting-probe/recovery/probe.ts) keeps GRS-106's and GRS-109's guards. It refuses (exit 2) a dirty tree, any Bun but 1.4.2, a storage-probe package that differs from its pin, or a `node` that is really Bun. It re-runs itself inside [`tests/e2e/pilot/offline.sh`](../../../tests/e2e/pilot/offline.sh), so the run has loopback only and the host resolver hidden, and every child gets the same environment allowlist. No account, login, token or Cloudflare request is possible. `--allow-dirty` exists for working on the probe and never gives `evidence: true`. The local state (about 11 MB) is deleted at the end unless `--keep-state` is given.

`evidence` is `true` only when every leg passes, HEAD and the tree are unchanged, and the checker refuses every mutation of the run's own summary. The checker holds the summary to one exact shape: the keys and types at every level, the run's identity and pins as literals, the number of commands and assertions per leg, the counts the legs fix as literals, and a value above zero for every timing. The committed run is [evidence/recovery-summary.json](evidence/recovery-summary.json). The commit after it changes only this page and that file, and `--check` and `test:check` verify that: `sourceSha` must be HEAD or an ancestor of it, and `git diff --name-only --no-renames <sourceSha> HEAD` may list only the two. A made-up `sourceSha`, one not in the clone, or one from before the last change to the Worker is refused.

## What runs where

| Step | Host |
| --- | --- |
| `bun build src/worker.ts`: this probe's Worker with GRS-109's storage Worker imported whole and unchanged (97,512 bytes, no `node:` or `bun:` import) | Bun 1.4.2 |
| Runner, HTTP requests, assertions, summary, the D1 dump used as a Time Travel stand-in | Bun 1.4.2 |
| `wrangler dev --local`, `wrangler d1 execute --local`, `wrangler r2 object put/delete --local` | Node 26.10.0 hosts Wrangler 4.151.1 only |
| The Worker | native workerd 1.20261012.1 under Wrangler |

D1 and R2 are Miniflare's local implementations inside workerd, so nothing here is evidence of remote D1 or R2 behaviour, limits or latency.

## The design the probe proves

[`src/worker.ts`](../../../tests/hosting-probe/recovery/src/worker.ts) puts these contracts in front of [GRS-109's storage Worker](storage.md). It reuses that Worker through its module boundary: every request first passes the storage identity gate (`GET /identity`), and every route this module does not own goes to the storage Worker unchanged. [`schema.sql`](../../../tests/hosting-probe/recovery/schema.sql) adds two tables to GRS-109's per-client database. Neither is a `uw_*` table, so case backups and user-work restores leave them alone.

- **A third binding, `RECOVERY`.** Each client deployment has its live D1 database and bucket, as in GRS-109, plus a recovery bucket that holds the client's recovery copies and a copy of its deletion records. It carries `identity/client.json` like the live bucket, and a crossed or missing identity answers 503 naming `RECOVERY`.
- **Deletion, four steps.** A firm admin requests (`requested`), a Global Admin approves (`approved`), the Global Admin offers a sealed export of the case (`offered`), and the Global Admin removes it (`removed`). Each step is one guarded batch on `case_deletion` and records its actor and time. Live access continues until removal. Removal erases every row of the case from every D1 table that `sqlite_master` lists with a `case_id`, `version_id` or `export_id` column. It then erases the case's objects: package files, lists, exports and their unsealed uploads, user-work snapshots, bundle history, the restore packets staged from its recovery copies (tagged with its id), and each original no other case records. Every case route then answers 410 `case-deleted`. Only the `case_deletion` row stays: ids, roles and times, and `erase_plan`, the version and export ids and the SHA-256 of each erased original (fingerprints of removed documents, never their bytes), so a repeat can finish. The deletion record in the buckets carries no `erase_plan`. [What writes where](#what-writes-where) lists every object and the path that removes it.
- **The deletion record.** Before erasing anything, removal writes `deletion/<caseId>.json` (`clearcase.deletion-record/1`) to the live bucket and to `RECOVERY`, write-once and byte-identical in both. A record missing from one bucket is copied back from the other.
- **Reapplied on every restore.** Staging a recovery copy, opening, stepping or finishing a GRS-109 restore packet, and a user-work restore of a removed case are refused. A refused packet is deleted, because it holds the deleted case's data. Every case route, stage and copy asks for the case's record in both buckets, whatever D1 says (one D1 statement and two R2 heads, no isolate-cached state): if either holds it and D1 does not hold the case as removed, the Worker reads the ledger and removes and erases every recorded case D1 does not hold as removed, then answers 410. A removal that finds a record already written adopts it instead of writing a new one with a new `removed_at`, so a Global Admin's retry succeeds. A new isolate applies the whole ledger before it serves its first request, which is how a fresh deployment or a database rolled back while no isolate ran is brought in line at once. A record of another client (503 `foreign-deletion-record`), or one with a missing or retyped field or the wrong key (503 `invalid-deletion-record`), stops the deployment and is never applied.
- **Recovery copies.** A copy is a sealed `clearcase.case-backup/1` (GRS-109) streamed into `RECOVERY` as `recovery/<caseId>/<copyId>.zip`, with R2 checking it against the export's SHA-256. Staging streams it back into the live bucket as an `import/` packet tagged with its case, checked again, for GRS-109's open, step and finish. The packet is deleted when its finish answers 200, when its open, step or finish is refused for a removed case, by the case's removal, and by rotation after 30 days.
- **Rotation.** Rotation deletes recovery copies, and `import/` restore packets, older than 30 days at the scheduled time, aged by R2's own `uploaded` time. It lists only `recovery/` in `RECOVERY` and `import/` in the live bucket. Live data, bundle history, deletion records and identities are outside what it reads. The probe's route, `POST /recovery/rotate {scheduledTime}`, takes the time from the request so the probe never waits 30 days, and exists only where the `PROBE_CLOCK` binding is set (client A's deployment). Any other deployment answers 404, which the `crossed-recovery` leg shows. The product has no such route and no such binding; see [the handoff](#product-and-runbook-handoff).
- **Bundle history.** A stand-in for GRS-128's PDF bundle versions (`bundle/<caseId>/<id>.pdf`, `bundle_version`), there only so the legs can show that rotation leaves it alone and that removal erases it.

### What writes where

Every `put` in `src/worker.ts` and in the storage Worker it imports, and the path that removes it.

| Write | Bucket and key | Tags | Removed by |
| --- | --- | --- | --- |
| Deletion record (`writeRecord`) | live and `RECOVERY`, `deletion/<caseId>.json` | client | never: it is the record of the removal |
| Recovery copy (`makeCopy`) | `RECOVERY`, `recovery/<caseId>/<copyId>.zip` | client, caseId, exportId, sha256 | rotation at 30 days; staging it is refused for a removed case |
| Staged packet (`stageCopy`) | live, `import/<packetId>.zip` | client, caseId | `erase` (every `import/` object tagged with the case), a 200 finish, a refused open, step or finish, rotation at 30 days |
| Bundle version (`putBundle`) | live, `bundle/<caseId>/<id>.pdf` | client | `erase`, by prefix |
| GRS-109: original, package file, list, user-work snapshot, export and its generated parts | live, `orig/<sha>`, `pkg/<v>/`, `rm/<v>/`, `backup/<case>/`, `export/<case>/` | client (generated parts none) | `erase`, by plan or prefix; an original only if no other case records it |
| GRS-109: uploaded restore packet | live, `import/<packetId>.zip` | none: it names no case until opened | a refused open, step or finish; a 200 finish; rotation at 30 days. Removal cannot find it ([Residuals](#residuals)) |

## Legs

Every leg ran at `6bd0a77aa1fe80d71d2e1300e3d8f9143e6c09aa`. Exit code 0. Each assertion's wording is in the summary.

| Leg | What it asserts | Result |
| --- | --- | --- |
| `build` | Bun builds the Worker offline with the storage Worker inside it; the bundle imports no `node:`, `bun:` or CommonJS module | PASS |
| `provision` | GRS-109's `schema.sql` and this probe's apply to three deployments (client A, client B, a fresh client A); each live database and bucket and each recovery bucket carries its client's identity | PASS |
| `crossed-recovery` | A recovery bucket with no identity object answers 503 `missing-identity` naming `RECOVERY`. Client A's Worker bound to client B's recovery bucket answers 503 `crossed-binding` on recovery, case and deletion routes, never names client B, and writes nothing (4 refusals). A deployment without `PROBE_CLOCK` has no rotation route: it answers 404 and removes nothing | PASS |
| `seed` | Cases A1 and A2 of client A, each with an active version, 2 originals (one of them shared, the same `orig/<sha256>` object), register rows carrying a `savedAt` timestamp, and one bundle version | PASS |
| `rollback` | A1 publishes V2, gains a row anchored to a V2-only document and an edit of a V1 row, then rolls back to V1. User work afterwards is byte for byte what it was before: every row id, seq, version, field and `savedAt`, and the case revision. The anchored row stays while V1 lacks its document. V1's package file is served with V1's SHA-256 and V2's is not served; V2's objects stay in R2. Originals are the same objects under either version. A stale rollback answers 409 and changes nothing. The next write takes the next seq and revision. Rolling forward serves the V2 document again with every row. 4 activations logged | PASS |
| `copies` | Four recovery copies sit in `RECOVERY` only, with their backups' SHA-256 and size; the live bucket keeps its own export. A copy with one byte flipped at rest is refused on staging (422 `copy-corrupted`). A1's second copy is staged into the live bucket and left unfinished, the packet of an aborted restore. A2 gains 2 rows after its copy. The whole database is dumped as the Time Travel stand-in point | PASS |
| `deletion-flow` | 12 refused steps: a request by a Global Admin, with no actor or no actor id, or for an unknown case; an approval by the firm admin or with no request; an offer or removal before approval; removal before the offer; an unsealed export or another case's export offered; a second request after removal. Live access continues while the deletion is requested. The firm downloads the offered export byte for byte. After removal, all 9 case routes answer 410 `case-deleted` with no case bytes; A1 holds no version, activation, original, revision or row; Wrangler's own query over every table `sqlite_master` lists with a case, version or export column finds 0 rows of A1; A1's package files, lists, exports, bundle history, its own original and the packet of its aborted restore are gone (16 objects); the shared original stays and A2 is unchanged. A repeated removal is a no-op. The deletion keeps its actors and times in order | PASS |
| `deletion-reapply` | A1's recovery copy made before the deletion is refused (409 `case-deleted`) and A1 stays deleted; this is the [red example](#red-first). The same backup uploaded as a packet is refused at open, step and finish, and the packet is deleted. A user-work restore answers 410. The record holds ids, roles and times only, and is in both buckets. The database is then rolled back under the running Worker: every table dropped and the earlier dump loaded through Wrangler. D1 holds A1 live again with no deletion. The Worker's next request for A1 finds its record in the buckets, reapplies the deletion and answers 410, and the residue query finds nothing. A2 is served from the rolled-back database without the row written after the dump (5 restores refused, 1 row lost to the rollback) | PASS |
| `restore-from-copy` | Client A's live database and bucket are lost, and a fresh deployment binds new ones beside the same `RECOVERY`. It sees the four copies and refuses A1's: the deletion record travels with the copies. A backup whose original entry changed between export and restore is refused by its CRC-32 before that original is written, and A2 is not activated. A2's copy is staged, opened, stepped and finished, and the packet is deleted once the finish answers 200. Its state digest equals the source's at copy time. GRS-12's check hashes every package file and the list. Both originals come back byte for byte under `orig/<sha256>`. User work is exactly the copy's, every row id, seq, version and `savedAt`, without the 2 rows written after the copy. One byte of a restored original flipped at rest then answers 410 with no bytes. The fresh database carries A1 as removed | PASS |
| `retention` | Rotation at the first copy + 30 days − 1 ms removes nothing; at + 30 days + 1 ms it removes that copy only. At A1's removal + 30 days + 1 ms no copy of A1 is left, and the deletion record stays in both buckets. A rotated copy cannot be staged. A firm admin's request to delete A2 that nobody approves is still only a request at + 400 days. At + 400 days A2 is live, verified and complete, its bundle version is kept, and the deployment's identity and live objects all stay. At + 400 days no object of A1 is left in either bucket, its staged packet included, except its deletion record. A packet uploaded through GRS-109 names no case: it survives rotation while younger than 30 days and ages out at + 400 days. Rotation with no or a malformed `scheduledTime` answers 400 naming the field | PASS |
| `ledger-guards` | A planted record naming client B answers 503 `foreign-deletion-record` from a fresh isolate's first request and is never applied. One with no `caseId`, and one stored under another case's key, answer 503 `invalid-deletion-record`, and A2 is not erased by them. With the planted record gone the deployment answers again | PASS |
| `warm-isolate` | A2 is approved and its export offered, and the running Worker has served it. A valid deletion record for A2 is put in both buckets while D1 still says `offered`. The same running Worker then answers 410 on all 9 case routes, reads and writes alike, with no case bytes. The Global Admin's retried removal succeeds, D1 holds the record's `removed_at` (the record is adopted, not replaced), and no row of A2 is left in any table | PASS |

### Red first

`e17714a3` committed the probe with the deletion flow and the copies but no deletion record. Its run on a clean tree failed `deletion-reapply` (exit 1, `PROBE FAIL e17714a3… evidence: false`): `restoring A1's earlier recovery copy, made before the deletion, is refused and A1 stays deleted ({"stage":"200","open":"200","step":"200","finish":"200"}; A1 now: active sha256:de0b1aed…, 2 originals, 4 rows)`. The deleted case came back with its originals and user work. `6ad9e97e` adds the records and their reapplication.

The fix round after review `bfd9e088` was red first as well. `efd29883` adds the `warm-isolate` leg, which fails at the base: on a running isolate every route of A2 answered 200 or 206 (a register add 200, an export 200) while both buckets held its record. `5051496b` stages a copy of A1 before its removal and uploads a packet: the packet outlived the removal and every rotation. `ff2e2185` makes `test:check` refuse a made-up `sourceSha`: against `bfd9e088`'s probe it printed `HOLE a made-up sourceSha passes --check`. Their fixes are `8dbdc462`, `1f181706` and `d50f9aef`; `6bd0a77a` counts the measured values and gates rotation's clock.

## Acceptance items

| Item | Leg | Status at `6bd0a77a` | Evidence |
| --- | --- | --- | --- |
| Acknowledged originals recover | local | PASS | `restore-from-copy`: originals byte for byte under `orig/<sha256>`, state digest equal to the source's |
| Disaster recovery loses at most one hour of recent Notes and case edits | cloud | HOLD (M2) | Needs D1 Time Travel. Locally, what each path loses was measured, not budgeted: a copy restore loses the writes since the copy (2 rows), and a database rollback loses the writes since its point (1 row) |
| Ordinary results rollback loses no user work | local | PASS | `rollback` |
| Rolling 30-day recovery copies apart from live case retention and bundle history; no automatic case or client purge | local | PASS | `copies`, `retention` |
| The same, rotated by the platform | cloud | HOLD (M2) | Time Travel keeps 30 days only on Workers Paid; an R2 lifecycle rule or a Cron Trigger runs only remotely |
| Firm-admin deletion request, Global Admin approval and export offer, live access removal | local | PASS | `deletion-flow` |
| Copy rotation within 30 days of removal | local (logic) | PASS | `retention`: at removal + 400 days no object of the case, its staged packets included, is left in either bucket except its deletion record. A packet uploaded with no case ages out within 30 days of upload ([Residuals](#residuals)) |
| Deletion records reapplied on restore | local | PASS | `deletion-reapply`, `restore-from-copy`, `ledger-guards`, `warm-isolate` |
| Four staffed-hour recovery aim, a soft initial goal, not an SLA or a launch gate | cloud | HOLD (M2) for the elapsed observation | [Four staffed hours](#four-staffed-hours-a-soft-goal) |
| Restore scope, corruption checks and a product and runbook handoff | local | PASS | [Restore scope](#restore-scope), [Corruption checks](#corruption-checks-on-restore), [Handoff](#product-and-runbook-handoff) |
| No current live clients need a migration or cutover project | | PASS (no leg) | The hosted service has no live clients yet; nothing in this design migrates one |
| Local-first legs on workerd (17 October addition): deletion flow, records on restore, rollback, restore from an R2 copy, corruption checks | local | PASS | every leg |

Neither restore defect that GRS-168 is fixing was hit. R1 needs a backup whose counts disagree; every backup here is one GRS-109 exported. R2 needs an original stored through multipart in the deployment being restored into; this probe's originals are single PUTs, and the fresh deployment holds none before its restore. A larger original shared with a live case would meet R2, so the product's restore waits for GRS-168.

## Restore scope

| What | Restored from | Scope | Here |
| --- | --- | --- | --- |
| One case: results record, read model, package files, list, originals and user work, Notes included | a recovery copy (`clearcase.case-backup/1` in `RECOVERY`) through GRS-109's restore | into a deployment of the same client, where the case is not live, never a removed case | PASS |
| A live case's user work | a `backup/` user-work snapshot (GRS-109's `work/restore`) | the case's `uw_*` tables, never a removed case | refusal shown (410); the restore itself is GRS-109's `user-work` leg |
| A whole client database | D1 Time Travel: any minute of the last 30 days on Paid, in place | every table, user work included (GRS-109's one-database layout), then every deletion record reapplied | HOLD; the local stand-in is a dump reloaded under the running Worker |
| A client's live bucket | the recovery copies, case by case, into a fresh deployment | every case with a copy younger than 30 days and no deletion record | PASS for one case |
| Publication | an older stored version, activated again | the `active` pointer only; user work and objects untouched | PASS |
| Not restored | deletion records win over every copy and every rollback; recovery copies and identities are never restored over; bundle history is not in a case backup (GRS-128 decides whether it is backed up or regenerated); grants, sessions, the audit log and outgoing email are outside this design |  |  |

## Corruption checks on restore

| Check | Where it runs | Shown by |
| --- | --- | --- |
| The copy's SHA-256, recorded from the sealed export, checked by R2 when the copy is written and again when it is staged | `POST /recovery/copies`, `…/stage` | `copies`: one flipped byte answers 422 `copy-corrupted` |
| Each object entry's archive CRC-32, over the whole entry, before its write | GRS-109's step | `restore-from-copy`: a changed original entry answers 422 `crc-mismatch` and the case is not activated. This shows the case GRS-109 left as a follow-up, an entry corrupted between export and restore |
| Each entry's manifest SHA-256, checked by R2 on write, and the finish's validation | GRS-109's step and finish | by construction (GRS-109) |
| The restored case's state digest against the source's at copy time | runner | `restore-from-copy` |
| GRS-12's check: every package file and the list hashed whole | `GET /cases/<case>/verify` | `restore-from-copy` |
| Every original read whole and hashed, its key and ETag its SHA-256 | GRS-109's delivery | `restore-from-copy` |
| A restored original changed at rest | GRS-109's delivery | `restore-from-copy`: 410 `changed-original`, no bytes |

## Four staffed hours, a soft goal

The aim is to bring a client's cases back within four staffed hours of an incident: hours in which someone is working the runbook. It is an initial goal to measure against. It is not a provider-outage SLA, and it is not a launch gate. These local wall times are **not budgets**: one host, local workerd and Miniflare on local disk, a synthetic case of a few kilobytes.

| Measure (`restore-from-copy`) | Local value |
| --- | ---: |
| Staging A2's copy into the fresh live bucket | 9.9 ms |
| GRS-109's open, steps and finish for it | 79 ms |
| The checks after it (digest, verify, originals, user work, corruption) | 84.7 ms |
| The whole leg, the refused copy and the corrupted packet included | 1,824.9 ms |

GRS-109's restore of one POC-size case (1,662 originals, 3.2 GB) into a fresh deployment took 126,622 ms locally ([storage page](storage.md#local-measurements-not-budgets)). The observation the aim needs is HOLD.

## Product and runbook handoff

| Owner | Takes over |
| --- | --- |
| GRS-117 (store) | `case_deletion`, the erasure by catalog, the deletion record in both buckets, reconciliation on each request, and the restore gates. Each user-work write checks the deletion state inside its own batch (see [Residuals](#residuals)) |
| GRS-113, GRS-114 (roles) | Who is a firm admin or a Global Admin. The probe takes the actor from the request body; the product takes it from the verified session |
| GRS-118 (exports) | The export offered at deletion. The probe offers the case backup because the Complete case export does not exist yet; the product offers the Complete case export, with Notes only when selected |
| GRS-128 (PDF bundles) | Bundle history retention, and whether bundle versions belong in the case backup |
| The cloud legs' owner, at M2 | Time Travel, the rotation schedule (a daily Cron Trigger whose `scheduled()` handler rotates at `controller.scheduledTime`, with an R2 lifecycle rule on `RECOVERY` as a backstop), and the HOLD legs. The product has no HTTP route for rotation and must not bind `PROBE_CLOCK`: a time named in a request would let any caller age out every copy |

Runbook, in the order an operator meets them:

1. **Delete a case.** The firm admin's request, the Global Admin's approval, the export offered and downloaded, then removal. Repeat the removal once in-flight requests have finished; it erases what a racing write left. The removal itself deletes the case's staged packets, and within 30 days of removal rotation deletes its recovery copies. A packet uploaded with no case until opened is the one thing removal cannot find; it ages out within 30 days of upload ([Residuals](#residuals)).
2. **Roll back a publication.** Activate the previous stored version with the current one as the expectation. Nothing is deleted, so rolling forward is the same step.
3. **Recover a case.** Stage its newest copy younger than 30 days, then open, step and finish. Check the state digest and `verify`. A removed case's copy is refused, which is the intended outcome.
4. **Recover a client database.** Restore D1 through Time Travel to the minute before the incident, then **redeploy the Worker**. A new isolate reads the ledger and reapplies every deletion record before it serves anything. A running isolate reapplies a case's record only when that case is next requested, so without the redeploy a revived removed case would keep its rows until then. Edits after that minute are lost; that is the one-hour RPO to observe.
5. **Recover a lost live bucket.** Bind a fresh database and bucket beside the same `RECOVERY`, provision their identities, and restore each case from its copy as in step 3. Deletion records come from `RECOVERY`.
6. **Rotate.** Run rotation daily from `scheduled()` with `controller.scheduledTime`, and from nowhere else: no HTTP route, and no `PROBE_CLOCK` binding. Never delete under `deletion/`.

## What stays HOLD

Each needs moment **M2**: Workers Paid plus R2 on an account the cloud legs' owner unpins, with D1 and R2 in the EU jurisdiction. They are the summary's `hold` array.

- **The one-hour RPO** for Notes and case edits through D1 Time Travel, which is remote-only. Write edits at known times, restore to a minute, and record what was lost. Repeat the deletion reapply after a real Time Travel restore; this probe's stand-in is a reloaded dump.
- **The 30-day rotation on the platform.** Time Travel keeps 30 days only on Paid (7 on Free). The Cron Trigger or R2 lifecycle rule that ages `RECOVERY` runs only remotely.
- **The elapsed restore observation** against the four-staffed-hour aim: a v5-size client restored on real Workers, D1 and R2, timed from incident to served.

## Residuals

- A user-work write whose case check passed just before the removal batch can commit after it. The row is unreachable (410) but stored until a repeated removal erases it. The product closes this by checking the deletion state inside the write's own batch, which this probe cannot do without changing GRS-109's Worker.
- A restore packet uploaded through GRS-109's route names no case until it is opened, so removal cannot find it. It is deleted by a refused open, step or finish and by a 200 finish; otherwise rotation deletes it 30 days after upload. A removed case's data can therefore sit in such a packet for up to 30 days after the upload. An unfinished multipart upload is not an object; R2 aborts it after 7 days by default, which this probe does not exercise. A stage that passed the removed-case check just before a removal can leave a tagged packet; the repeated removal in runbook step 1 sweeps it.
- The ledger is as trusted as the buckets. A credential holder could plant a well-formed record of this client and erase a live case; records carry no signature. A foreign or malformed record stops the deployment instead.
- A record planted under a running isolate takes effect at that case's next request, and the rest of the ledger when an isolate starts. After a Time Travel restore the revived rows of a removed case are erased when the case is next requested or a new isolate starts, which is why runbook step 4 requires the redeploy.
- An original no other case records is deleted after a fresh D1 check. A head and a delete are not atomic, as in GRS-109's residuals.
- The deletion gate adds one D1 statement and two R2 heads to each case request, and a new isolate reads the whole ledger once. GRS-109's per-route counts do not include them.
- A copy is one streaming PUT, so a case backup above R2's single-PUT limit (about 5 GiB) cannot be copied or staged; GRS-109's v5-size export (3.2 GB) is below it. A larger backup needs a multipart copy. An M2 residual, beside the elapsed restore observation.

## Follow-ups

- Fold the restore probe's harness (offline entry, Wrangler serve and stop, proxy retry) and GRS-109's into one shared module; the two runners repeat it.
- Check the deletion state inside every user-work write's batch (GRS-117), then remove the repeated-removal step from the runbook.
- Decide whether bundle versions go into the case backup (GRS-128).
- A restore must not revive a revoked grant either (REVIEW.md, capability outlives authority); that needs grants, which GRS-113 owns.
