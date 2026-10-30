# Ticket breakdown: tracer-bullet slices for the 5 November demo

Source: `spec.md`. Feasibility was proven by the spike in `research/spike-hosted-views.md`: three views ported unchanged in 27 minutes; they build for Workers and pass `check:hosted-imports`, `tsc` and `svelte-check`; the bundle is about 4.3 MB for all 42 views against a 64 MB limit; warm pages render in 4–6 ms on workerd. The spike code is on the unpushed branch `spike/hosted-views-20261028` (a1e5b98e) for reference; don't merge it. Each ticket is a vertical slice that can be shown on its own preview URL or on staging. The size assumes one strong agent; a half-day ticket should take about 2 hours from claim to merge. "Journey" names the acceptance journey in `research/journeys.md` that proves the ticket. **Sec** marks a security-sensitive ticket: its one review is a review by the other model family against the four hosted classes.

## Wave 0: start now, all in parallel
| # | Ticket | Delivers (verifiable) | Blocked by | Size |
| --- | --- | --- | --- | --- |
| 01 | Sprint operating kit | A colleague's Claude or Codex agent runs `/goal`, claims a ticket, and opens a PR into the sprint branch. CI-lite finishes in under 5 min. The repo AGENTS sprint block, the `goal` skill, CI-lite for `sprint/**`, branch protection, sprint-mode skips for the hard-coded test-count guards, reserved migration numbers, follow-ups as issue comments, Linear views. | none | 0.5 d |
| 02 | Staging environment | A colleague passes Access and signs in at the staging URL running the sprint head. `wrangler preview` gives a branch its own URL on the staging data. Committed staging config, deploy script, preview script, KV, Clerk staging app. **Needs the owner:** Zero Trust enablement and the Clerk keys. | none | 0.5–1 d |
| 03 | Route base, hosted availability and shared seams | Every link builder takes a base prefix (today `docPath`/`versionPath` send hosted citations to the local app). An availability overlay marks views as ported, coming soon or never, and replaces the catch-all 503 for unported views. The hosted-imports guard accepts `.css` imports, and the hosted tree loads the global stylesheet (both found by the spike). The local app is unchanged (J1 passes locally). | none | 0.5 d |
| 04 | Payload contract | The shard types in one module, and nine mixed loaders split into pure and merge parts. The local app is unchanged; the fixture tests pass. | none | 0.5 d |
| 05 | Journeys and request budget in the repo | `bun run journeys` runs J1–J10 against local, a preview or staging (refs come from env, never committed). A request-budget test counts D1, Clerk and R2 calls per hosted route. | none | 0.5 d |

## Wave 1: the tracer bullet, plus parallel lanes that don't wait for it
| # | Ticket | Delivers | Blocked by | Size |
| --- | --- | --- | --- | --- |
| 06 | **TRACER: v5 overview on staging from shards** | The operator runs the builder on v5, uploads the shell, overview and manifest, registers the version, records a sign-off bound to the manifest and publishes. A colleague signs in and opens the overview in under 2 s, with the sidebar showing every other view as coming soon. J1 and J2 pass on staging. | 02, 03, 04 | 1.5 d |
| 07 | v5 originals on staging | A full-folder convert. Every referenced original is rclone'd to staging storage by content hash, with original rows and the originals index. Any v5 original opens on staging through the existing route. | 02 | 0.5 d |
| 08 | Fast originals (Sec) | Ranged, streamed delivery with no re-hash; one authorization; a non-blocking audit row; an asset ticket for range requests; presigned URLs for files over 100 MB. J4 on staging: a 633-byte PDF in under 1.5 s, the 258 MB PDF's first page in under 3 s. | 02 (07 for the large-file check) | 1–1.5 d |
| 09a | App session and revocation (Sec) | Clerk only at sign-in and sign-out; an 8-hour sliding HttpOnly session; KV revocation on sign-out. Sign-in under 5 s; J10 with a 20-minute idle has no 401 or 503. | 02 | 1 d |
| 09b | One grant lookup and lean audit (Sec) | One indexed grant query per request; read audit after the response with no read-back; change audit in the same batch. The budget test shows 0 Clerk calls and at most 1 D1 call per page. | 02, 05 | 1 d |
| 10 | Prototype shell restyle | Prototype tokens, the dark numbered sidebar, a top bar (search with Ctrl+K, version pill, account and sign-out, case switcher), cards, the coming-soon panel and a mobile drawer, with the system font stack only (no Montserrat, Schibsted or Instrument font files), on the shared components, so both local and hosted pick them up. J1 passes; screenshots at 1440 and 390 px match `research/ui-spec.md`. | 03 | 1–1.5 d |

## Wave 2: fan-out once the tracer is merged
| # | Ticket | Delivers | Blocked by | Size |
| --- | --- | --- | --- | --- |
| 11 | Chronology with split viewer | The chronology from paged list shards and facets. Clicking an entry opens its document and original beside the list; a citation opens in one click. J3. | 06 | 1 d |
| 12 | Documents list and document page | The documents list (paged, filtered) and the document page from document shards: metadata, attachments, related documents, the original link, and "original not supplied" or "inside the parent message" states. J4 (navigation part). | 06 | 1 d |
| 13 | Analysis views, part 1 | Matter & Strategy, Timeline, Contradictions, Risk Matrix, Defence & Rebuttal, Witnesses, People, Entities and Conflict Check from dataset shards. J5 for those views. | 06 | 0.5–1 d |
| 14a | Analysis views, part 2 | Cause of action, legality, contracts, quantum and interest, invoice ledger and prescription. J5 for those views. | 06 | 0.5–1 d |
| 14b | Mixed views, read path | Filings, payments, interest recalculator, settlement, enforcement, cross-examination, authorities, heads and info required render their shard content merged with D1 rows (read-only until 17b). | 06, 04 | 1 d |
| 15 | Search | A search-index shard; the search view and top-bar search return results in under 2 s. J6. | 06 | 0.5–1 d |
| 16 | Notes, plus the user-work adapter | One adapter for the local form actions over the hosted user-work store. Document notes save and survive a reload; the case notes list shows note bodies; the overview tile counts them. J7. | 12 | 1 d |
| 17a | Deadlines and registers | Seven registers with save, edit and delete; deadline countdowns; .ics export; a deadline tile on the overview. J8. | 16 | 1 d |
| 17b | Litigation and quantum entries | Writes for authorities, heads, cross-examination, payments, enforcement status, the filings register and info required. | 16, 14b | 1 d |
| 18 | Bundles | A bundle-paths shard; discovery, court bundle and CaseLines on hosted; custom bundles saved, with the assembled PDF still present after a reload; downloads through asset links or presigned URLs. J9. | 06, 16 | 1–1.5 d |
| 19 | Small client uploads | The intake link is visible on the case page; small files go to storage and the team is notified. | 02 | 0.5 d |

## Wave 3: the release candidate
| # | Ticket | Delivers | Blocked by |
| --- | --- | --- | --- |
| 20 | RC gate, Monday 2 November | Staging is pre-loaded with a few notes, deadlines and a custom bundle. J1–J10 run from a South African network at a recorded SHA. Each failing step becomes a `journey-fail` issue. | 06, 08, 09a, 10, 11, 12, 13, 14a, 15 (16–18 if merged) |

**boat.dev:** the owner alone uses one $20 boat account (one seat: 200 starts a day, 555 hours a month, 10 saved snapshots). Ticket 01 builds the `clearcase-golden` snapshot and `scripts/boat/run-checks.sh` for the owner's machine; colleagues run checks locally. If the VMs are busy, they're busy.

**Critical path:** 03 and 04 (half a day) → 06 (1.5 d) → 12 (1 d) → 16 (1 d) → 17a or 18 (1 d), so about 5 days from Wednesday afternoon to Monday. Everything else runs beside it: three developers' agents keep about six tickets in flight.

## Backlog after the demo (not `ready-for-agent` yet)
- The rclone ingest runbook, a NAS census and a 100 GB pilot.
- The per-case file catalogue with FTS5 file-name search and keyset paging, tested on a synthetic set of 1M rows.
- The batch bundle with a Workflow importer, replacing the staged import.
- Stable references across batches, and results-package format version 2 (a processing-contract amendment).
- A client production instance on a custom domain, once the domain's nameservers are active.
- The staff publication UI over the new manifest-bound sign-off.
- Open owner decision: how a release reaches a client. Either each developer holds a user on every client's Clerk app and previews per client, or a full preview on staging is promoted to the client Worker. Staging alone is enough for the demo.
- The sprint-to-dev PR with the full review, Greptile, `gate` and `gate:hosted`.
