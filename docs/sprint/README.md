# ClearCase recovery plan: hosted demo on Thursday 5 November 2026

Written 28 October 2026 after the post-mortem and the grilling session with the owner. Supporting analysis sits beside this file: `architecture.md` (the Cloudflare target design, with sources), `port-map.md` (how the local views move to hosted), `state-and-process.md` (what exists where, what to keep or drop, and the lean process) and `postmortem.md` (why the first attempt failed). The Astra timing evidence stays in the owner's private `.orchestration/reports/recovery-20261028/`, because it holds real case IDs. On this branch, this file wins over every other process file, including the owner's workspace `AGENTS.md`, `ORCHESTRATOR.md` and `REVIEW.md`. Every agent working on the sprint reads it first.

## Goal and dates
- **Thursday 5 November:** a client demo on the **hosted** app (staging on Cloudflare), with the v5 case, polished.
- **Monday 2 November, end of day:** a working release candidate on staging. Monday to Wednesday is for fixing bugs only, with no new features.
- **After the demo:** onboard the 14–17 TB client. The data is collected on the NAS, culled and processed on the Sparks, then imported batch by batch into that client's own instance.

## What the demo must show
1. **Must have:** overview, and a chronology with a split pane that opens the backing document.
2. **Must have:** the documents list, a document page, and any original PDF opening within seconds.
3. **Must have:** the analysis views: Matter & Strategy, Contradictions, Risk Matrix, people, entities, litigation and quantum (about 24 read-only views).
4. **Right behind (stretch for the demo, first thing after it):** notes, deadlines and bundles.
5. **Look:** the partners' prototype v0.1 (attached to the Linear sprint document and the restyle issue; it holds real case dates, so it stays out of Git): sidebar navigation, a top bar with search and a freshness pill, cards. Views not yet ported show a "coming soon" placeholder.
6. **Speed targets (a release blocker):** measured from South Africa, a page view under 2 s at p95 and the first PDF page under 3 s. No 401 or 503 during a session that includes a 20-minute idle.

## Measured baseline, 28 October (Astra, real Chromium, from the owner's network)
| Step | Local release candidate (dev `1ed4b634`) | Hosted (B `d8d4b4bf`, London pin) |
| --- | --- | --- |
| Sign in | none needed | 11.5 to 24 s, about 80 requests (several Clerk hops) |
| Open a case or view | 60 to 300 ms per view; all 42 views | 1.2 to 3.6 s per page; clients see no views (nothing published) |
| First page of a PDF | 0.25 s (9 KB); 1.9 s (**258 MB**) | 4.5 to 7 s even for a 633-byte file: viewer HTML about 2.2 s, then the bytes about 2.3 s, one after the other |
| Search | 71 ms | 503 on A, B and mobile |
| Chronology citation to its document | 1 click, 0.34 s | not available to clients |
| Note save | 2.1 to 4 s (slow locally too) | 1.8 to 5.4 s |
| Import of v5 | 29 s | 62 min intake plus 49 min import; 613 originals over 16 MiB never uploaded |

Hosted acceptance tests taken from this: sign-in in under 5 s; the 258 MB original's first page in under 3 s through range streaming; search returns results; page notes appear in the case notes list; the intake link is visible from the case page. Local bugs to fix while porting: slow note saves, and the assembled bundle PDF being lost after a reload.

## Decisions made on 28 October (owner)
- **Stay on Cloudflare** (Workers, D1, R2, KV, Workflows). The slowness comes from the number of calls per request, not from the platform.
- Check integrity **when a file is stored**, not on every read. On read, compare against the stored tag.
- **8-hour app session** after Clerk sign-in, with revocation through KV within about a minute.
- **Audit every read without blocking:** one row per request, written after the response with no read-back. Changes stay audited and fail closed.
- **A failed preview is a warning, not a publication blocker.** Sign-off stays bound to an exact version.
- Upload only the kept, culled set to R2, in priority order.
- The owner allows the real v5 case on the sandboxes and staging. Before the demo, confirm it is acceptable to show v5 to a prospective client (it is another client's matter), or use a scrubbed copy.
- **Lean process on the sprint branch only.** `dev` and `main` stay strict: Greptile, CI and the full review happen on the single sprint-to-dev PR.

## Architecture (summary; details in `architecture.md`)
- **Request budget per route:** 0 Clerk calls, at most 1 D1 query, at most 1 R2 read. A CI test enforces this.
- **Auth:** networkless Clerk JWT verification at sign-in, then an HttpOnly app session cookie (HMAC, 8 hours sliding, 24 hours at most), a KV revocation key, and one indexed grant query per request.
- **Originals:** `bucket.get(key, { range, onlyIf: etag })`, streamed with no hashing. A viewer page mints a 15-minute HMAC asset ticket, so range requests from pdf.js cost no D1 queries. Downloads over about 100 MB go through presigned R2 URLs.
- **Read model:** the operator machine builds immutable per-version JSON shards (per view, chronology pages, per-document payloads and a search index), uploads them to R2 and records the manifest hash in D1. The Worker authorizes, then serves from the Cache API, or from R2 on a miss. Publication flips a KV pointer. `loadVerifiedModel` and per-request hashing go away.
- **D1** holds grants, notes, registers, deadlines, custom bundles, audit, versions and (later) the per-case file catalogue.
- **Placement:** pinned to London in the wrangler config for every environment, beside the EU D1 and R2.
- **Ingest at scale (after the demo):** rclone from the operator machine or NAS straight to R2 over the S3 API, keyed by SHA-256. Results arrive as one sealed bundle per batch and are imported by a Workflow; batches are append-only.

## Branches and environments
- **Sprint branch:** `sprint/hosted-demo-20261105`, cut from `d8d4b4bf`. That is sandbox B's live code, a strict superset of everything from 27 October; none of it is on `dev` yet. Push it to origin so all three developers can use it.
- **Ticket branches:** `sprint/<ticket-key>-<slug>`, cut from the sprint branch, with PRs back into it. Merge commits only, and never touch `dev` or `main`.
- **Staging:** a new Worker `clearcase-staging` with its own D1, R2 and KV, a Clerk development instance and the London pin, behind Cloudflare Access. It is loaded with v5 (all 1,753 originals, uploaded straight to R2) and auto-deploys on every merge into the sprint branch.
- **Per-ticket previews:** `wrangler preview` (Wrangler 4.135 or later) gives each ticket branch its own URL under the staging Worker. A `previews` block in the config binds them to the staging D1, R2 and KV; Access covers them too.
- **A and B sandboxes:** frozen. Do not redeploy them during the sprint unless a colleague needs it.
- **Freeze, don't extend:** staged import with leases, the online evidence engine and native render checks, the grant-renewal producer. **Drop for two weeks:** the native24 recovery branches and GRS-26, 190, 203 and 204.

## Tickets (disjoint paths, so they can be claimed in parallel)
| Key | Ticket | Paths | Size | Depends on |
| --- | --- | --- | --- | --- |
| S0 | Sprint branch, staging Worker, Previews config, Access, London pin, CI-lite (tsc plus targeted tests) on PRs into the sprint branch | `deploy/`, `.github/`, wrangler configs | 0.5 d | – |
| S1 | Payload contract: shard types in `src/lib/views/payloads.ts`, hosted route prefix, `versionPath`/`docPath` taking a prefix | `src/lib/views/payloads.ts`, `src/lib/local-case/model.ts` | 0.5 d | – |
| S2 | Originals fast path: ranged R2 get, no re-hash, one authorization, non-blocking audit, asset ticket; viewer HTML and bytes no longer wait on each other; the 258 MB v5 original opens its first page in under 3 s | `src/lib/viewer/hosted/`, `src/lib/storage/cloud/objects.ts`, `src/lib/results/hosted/assets.ts` | 1–1.5 d | – (security review) |
| S3 | Auth: networkless JWT, 8-hour app session, KV revocation, one grant query, audit without read-back; sign-in under 5 s (today 11 to 24 s) | `src/lib/auth/`, `src/lib/tenancy/`, `src/lib/audit/` | 2 d | – (security review) |
| S4 | Payload builder (operator side): build v5 shards, upload to R2, manifest in D1, publication rule change (preview warnings; required render → manifest present) | `scripts/publish/`, `src/lib/publication/hosted/` rules | 2 d | S1 |
| S5 | Hosted shell: `cases/[caseId]/v/[rv]/` layout with ViewNav, `payloads.server.ts`, generic dataset loader | `deploy/client/routes/cases/[caseId]/v/`, `src/lib/views/hosted/` | 2 d | S1 |
| S6 | Overview, chronology with split pane, documents, document page | the matching routes under S5's prefix | 3 d | S5 (S4 for real data) |
| S7a and S7b | Analysis views, split in two halves (analysis and people on one side, litigation and quantum on the other) | the matching routes | 1.5 d each | S5 |
| S8 | Prototype restyle: tokens, sidebar, top bar, cards, placeholders | `src/lib/components/`, style files | 2 d, starts day 1 | – |
| S9 | Load v5 into staging: rclone all 1,753 originals, including those over 16 MiB, run the S4 builder, publish | runbook plus `.local` | 0.5 d | S0, S4 |
| S10 | Search over the shard index (today a 503), the intake link on the case page, and the timed journey (Astra from South Africa) plus the CI round-trip budget test | `tests/budget/`, `.local/astra` | 1 d | S0 |
| S11 (stretch) | Notes and deadlines on hosted views (D1 user work already exists); page notes listed in case notes; faster note saves | registers routes | 2 d | S5 |
| S12 (stretch) | Bundles; the assembled PDF survives a reload | bundles routes | 2 d | S5, S4 |
| P1 (after the demo) | rclone ingest runbook, NAS census, pilot of 100 GB | runbook | 1 d | – |
| P2 (after the demo) | Per-case catalogue D1, FTS5 file-name search, keyset paging, a synthetic 1M-row test | – | 4 d | – |
| P3 (after the demo) | Batch bundle plus Workflow importer, replacing staged import | – | 4 d | S4 |

Critical path: S1 → S5 → S6 → S9 → S10, about 6.5 builder-days. It fits by Monday only if S1 lands today and S5 and S6 start tomorrow morning. Start S2, S3, S4, S7 and S8 in parallel.

## How three developers and their agents work together
- **Claiming:** each ticket is a Linear issue labelled `sprint-hosted-demo`, with its reserved paths in the description. To claim one, assign yourself and move it to In Progress. One ticket per agent at a time. When the PR has merged, claim the next.
- **The loop:** branch, build, run targeted tests and `tsc`, `wrangler preview`, then a 2-minute self-check on the preview URL. Open a PR into the sprint branch. One review (another developer's agent, at most an hour and five findings). Fix any High or Medium in the same session. Merge. No re-check rounds; Lows go to `follow-ups.md`.
- **Security review** only for S2, S3 and anything under `auth/`, `tenancy/` or the grant producers. That review counts as the one review.
- **Third round on the same problem:** change the premise, not the model. Ask the owner.
- **Staging** deploys on every merge. **Daily:** someone uses staging on a laptop and a phone for 10 minutes and writes three lines (slow, broken, wanted) in the shared log. The orchestrator reads them first thing.
- **Status:** at most 30 lines, overwritten, never appended.
- **Kept guards:** the leak scan with the pre-push hook, `base-guard`, `doctor`, CI `check`. Parked until the dev PR: merge-check records, test-guard, fix-round-guard, approval-check, compute fleet, the Greptile loop.

## Gates
- **Monday 2 November, release candidate:** the timed journey on staging passes the speed targets for the three must-have groups, at a recorded SHA.
- **Wednesday 4 November:** a full rehearsal by a person on the demo laptop and network, plus a rollback SHA.
- **After the demo:** one sprint-to-dev PR with the full review, Greptile, CI, `gate` and `gate:hosted`, then the cleanup.
