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
- **Lean process on the sprint branch only.** `dev` and `main` stay strict: Greptile, CI and the full review happen on the single sprint-to-dev PR. Greptile is not used on sprint PRs; each gets one agent review instead.

## Architecture (summary; details in `architecture.md`)
- **Request budget per route:** 0 Clerk calls, at most 1 D1 query, at most 1 R2 read. A CI test enforces this.
- **Auth:** networkless Clerk JWT verification at sign-in, then an HttpOnly app session cookie (HMAC, 8 hours sliding, 24 hours at most), a KV revocation key, and one indexed grant query per request.
- **Originals:** `bucket.get(key, { range, onlyIf: etag })`, streamed with no hashing. A viewer page mints a 15-minute HMAC asset ticket, so range requests from pdf.js cost no D1 queries. Downloads over about 100 MB go through presigned R2 URLs.
- **Read model:** the operator machine builds immutable per-version JSON shards (per view, chronology pages, per-document payloads and a search index), uploads them to R2 and records the manifest hash in D1. The Worker authorizes, then serves from the Cache API, or from R2 on a miss. Publication flips the `rs_publication` row in D1. `loadVerifiedModel` and per-request hashing go away.
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

## Tickets
The tickets are `docs/sprint/tickets/NN-*.md`, mirrored as Linear issues **GRS-244 to GRS-266** in project P-GRS-21 (label `sprint-hosted-demo`). `docs/sprint/tickets/README.md` has the dependency graph, the path-ownership table, the reserved migration numbers and the owner's actions; each ticket file has its reserved paths, blockers, acceptance, exact checks and decisions already made. The old S0–S12 table and GRS-227 to 243 are superseded.

Critical path: 03 and 04 → 06 (the tracer) → 12 → 16 → 17a or 18, about 5 days to Monday. Wave 0 (01 to 05) starts at once and in parallel.

## How three developers and their agents work together
- **Claiming:** pick a Todo issue with the label, no assignee and every blocker Done. Assign yourself, move it to In Progress, comment `claim: ...`, re-read after 15 s. One ticket per agent at a time. After 01 merges, `/goal finish tickets` runs this loop.
- **The loop:** branch, build, run the ticket's Checks block, `scripts/preview.sh`, then a 2-minute self-check on the preview URL. Open a PR into the sprint branch. One review: a fresh agent session on the other model family runs `/sprint-review` and posts one `review:` comment (at most 5 findings, about 30 minutes). Fix any High or Medium in the same session, push once, merge. No re-check rounds; Lows go to the issue as a `follow-ups:` comment.
- **No Greptile on sprint PRs.** It reviews only the final sprint-to-dev PR.
- **Security-sensitive tickets** (08, 09a, 09b, and anything touching auth, tenancy, audit, sign-in routes, grant producers or R2 object serving): the one review also checks the four hosted classes, with up to 3 probes.
- **Third round on the same problem:** change the premise, not the model. Ask the owner on the issue.
- **Staging** deploys on every merge. **Daily:** someone uses staging on a laptop and a phone for 10 minutes and writes three lines (slow, broken, wanted) in the Linear "Human log" document.
- **Heavy checks:** the owner can run them on boat.dev VMs (`scripts/boat/run-checks.sh`, from 01); colleagues run checks locally.
- **Kept guards:** the leak scan with the pre-push hook, `base-guard`, `doctor`, CI-lite. Parked until the dev PR: merge-check records, test-guard, fix-round-guard, approval-check, compute fleet, the Greptile loop.

## Gates
- **Monday 2 November, release candidate:** the timed journey on staging passes the speed targets for the three must-have groups, at a recorded SHA.
- **Wednesday 4 November:** a full rehearsal by a person on the demo laptop and network, plus a rollback SHA.
- **After the demo:** one sprint-to-dev PR with the full review, Greptile, CI, `gate` and `gate:hosted`, then the cleanup.
