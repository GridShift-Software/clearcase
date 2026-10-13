# CC-11 (GRS-21): M2 readiness gate

The gate author's evidence for complete v5 parity and local release readiness. It is not the final verdict: a fresh second reviewer reruns the critical paths at the exact revision ([reviewer-guide.md](reviewer-guide.md)) and gives the final PASS. The user's visual review uses [walkthrough.md](walkthrough.md).

- **Evidence revision:** `2243fc3f956935c54ac100177576a359d81c6400`. Every run below was made at this revision on a clean tree. The commit after it adds `docs/` (these results, the matrix, the defect table and the guides) and corrects one sentence of the matrix's wording in `scripts/verify/matrix.mjs`; the matrix was regenerated from the same evidence.
- **Base:** dev `c064458`. No file under `src/` changes on this branch.
- **Author's verdict:** HOLD. The local workflow, parity and metrics pass. Two app findings (F1, F2) and the defect dispositions (F4) fail; they are listed under [Findings](#findings).

## Commands and results at `2243fc3`

| Check | Command | Exit | Result | Output (ignored, local) |
| --- | --- | --: | --- | --- |
| Gate | `bun run --bun gate` | 0 | `GATE PASS 2243fc3f9569`: build, check, test, test:e2e (pilot 38/38; analysis 21/21, bundles 51/51, evidence 14/14, litigation 43/43, quantum 57/57, registers 43/43, system 14/14; UI classes 253/253), strict parity, the v5 lanes | `.local/gate/` |
| Strict parity | gate step `parity --all --strict-register` | 0 | 42 views extracted on both sides; 103,130 values compared, 99,766 matched, 3,364 registered, 0 unregistered; 0 not-yet-implemented | `.local/gate/parity-out/scorecard.md` |
| Real v5 lanes | gate step `verify:pilot:v5` | 0 | 18/18 lanes PASS | `.local/gate/v5-out/lanes-v5.json` |
| Acceptance workflow | `scripts/verify/evidence.sh acceptance` | 0 | 8/8 scenarios (AC1–AC8) | `.local/GRS-21/acceptance-out/acceptance/` |
| Layout, synthetic | `scripts/verify/evidence.sh layout` | 1 | 42 views × 4 widths, 8 components, 168 screenshots: 0 view failures, 1 shell contrast failure (F1), 8 component failures (F1, F2). Rerun at GRS-67 `5d15b8b`: exit 0, 0 failures | `.local/GRS-21/layout-synthetic/layout.json` |
| Layout, v5 sample | `scripts/verify/evidence.sh layout-v5` | 1 | 42 views × 4 widths, 8 components, 168 screenshots: 0 view failures, 1 shell contrast failure (F1), 8 component failures (F1, F2). Rerun at GRS-67 `5d15b8b`: exit 0, 0 failures | `.local/GRS-21/layout-v5/layout.json` |
| Metrics | `scripts/verify/evidence.sh metrics` | 0 | see [Metrics](#metrics) | `.local/GRS-21/metrics/metrics.json` |
| Dispositions | `scripts/verify/evidence.sh dispositions` | 1 | finding F4. Rerun at GRS-67 `5d15b8b`: exit 0, 159 of 159 defects registered, the 4 imported-data defects tagged; [defects-table.md](defects-table.md), regenerated there | `.local/GRS-21/dispositions.json` |
| Matrix | `scripts/verify/evidence.sh matrix` | 0 | [matrix.md](matrix.md) | – |

`scripts/agent-tools/doctor` fails on this host, because three installed skills differ from `skills.lock.json`. That is an environment drift, not part of this branch, and no check above depends on it.

## Acceptance items

| # | Item | Verdict | Evidence |
| --: | --- | --- | --- |
| 1 | All 42 views and their actions, PASS/FAIL/BLOCKED at the reviewed revision; no placeholder passes | PASS for all 42 views | [matrix.md](matrix.md): strict parity compared all 42 with 0 not-yet-implemented entries, and every view has passing browser scenarios. Shell-wide findings F1 and F2 are listed once, above the table. |
| 2 | Offline import-to-original workflow, then edit, restart, backup, restore and activate a replacement without losing user work | PASS | acceptance AC1–AC7, offline in a network namespace with only `lo` |
| 3 | Keyboard and focus, Back, labels, contrast, layouts at 320/390/768/1280; screenshots and walkthrough | FAIL | Keyboard, Back, labels, overlap and sideways scroll pass for all 42 views at all four widths, on both cases. The shared contrast fails (F1, F2). Screenshots are indexed in [walkthrough.md](walkthrough.md). |
| 4 | Interleaved reference/head metrics and absolute budgets; known-data defects reviewed; user visual review requested | PASS for the metrics; defects FAIL (F4); visual review open | [Metrics](#metrics); [defects-table.md](defects-table.md); the visual review is the user's |
| 5 | Second reviewer reruns critical paths | open | not the author's: [reviewer-guide.md](reviewer-guide.md) |
| 6 | `docs/development.md` extended after CC-03 | PASS | section "M2 readiness checks (GRS-21, CC-11)" and the updated known limits |
| 7 | `docs/user-guide.md` extended after CC-10 | PASS | "Windows quick start" (GRS-64), marked as not verified on Windows |
| 8 | BA-01 to BA-21 dispositions reviewed against owners | PASS with holds | [BA review](#ba-01-to-ba-21) |
| 9 | Hostile imported content and original-preview isolation; parity reported apart from production-only and deferred capabilities | PASS | AC8 and the pilot suite's S13/S28/S29; [Isolation](#isolation) |
| 10 | BA-12, BA-13, BA-14, BA-21 verified by this gate | FAIL | BA-13 fails (F1, F2). BA-12, BA-14 and BA-21 pass. |
| 11 | Backup-and-restore round trip for every store on CC-10's coverage list | PASS | AC5: each of the 21 stores and the notes equal after a restore into a clean profile; `tests/system/stores-21.test.ts` (gate `test`) |
| 12 | Every v5 source defect has a register disposition; imported-data defects tagged `data-correction-deferred-to-pipeline` | FAIL | F4 |

## Verification steps 1–10

| Step | Verdict | Evidence |
| --- | --- | --- |
| 1. Reference and rewrite side by side | PASS | strict parity, 42 views; v5 lane 1 |
| 2. Every view and meaningful action | PASS for all 42 views | [matrix.md](matrix.md) |
| 3. All citations and original mappings | PASS | AC2: every document of the synthetic case resolves to its case-folder bytes (sha256) and one opens in the viewer; v5 lanes 5, 6, 7, `routes`, `pages` |
| 4. Fixed search and numeric examples | PASS | v5 lane 4; parity (the search and quantum views compare every value); the quantum suite |
| 5. Edit every mutable state category, then restart | PASS | AC3 (every form and every non-form save of every page; 21 stores and notes hold rows), AC4 |
| 6. Backup and restore into a clean profile | PASS | AC5 |
| 7. A failed import keeps the previous case active | PASS | AC6 (an altered package is rejected and user work is unchanged); v5 lane 8 |
| 8. Fully offline | PASS | every suite and script runs in a network namespace with only `lo` and proves it first; v5 lane `isolation` |
| 9. Keyboard, contrast and four viewport widths | FAIL | layout runs: keyboard and widths pass; contrast fails (F1, F2) |
| 10. 30–60 s walkthrough and the differences register | open | [walkthrough.md](walkthrough.md) for the user's review; the register has 217 entries, all `approvedBy: null` |

## Metrics

Measured at `2243fc3f9569` on this host (20 cores, 15 GiB), offline, with the production build under Bun. Each metric has 20 kept samples after 2 warm-up samples, and percentiles are nearest-rank. Cold overview and warm navigation alternate sample by sample between the v5 reference and the head, in the same browser; the reference column is reported beside the head's, with no ratio. Search and state write have no comparable v5 scenario. Search is a server round trip in the app and an in-page filter in v5; state write saves to SQLite in the app and to localStorage in v5. They are gated on their absolute budgets only.

| Metric | Scenario | Head p50 / p95 ms | v5 reference p50 / p95 ms | Budget p95 ms | Verdict |
| --- | --- | --- | --- | --: | --- |
| Cold overview | fresh browser context: navigation start to the overview rendered, then the next frame | 101.3 / 110.7 (n=20) | 122.2 / 127.6 (n=20) | ≤ 2000 | PASS |
| Warm navigation | one warm tab: a click on Chronology to the chronology rendered, then the next frame | 75.5 / 90.5 (n=20) | 18.1 / 18.4 (n=20) | ≤ 200 | PASS |
| Search | `measure --ticket CC-04`: a click on Search to the results rendered, on the v5 sample | – / 36.2 (n=20) | no comparable scenario | ≤ 300 | PASS |
| State write | `measure --ticket CC-07`: a click on Save to the row rendered, 500 rows per register; worst of 7 registers (`registers.timesheet_tab.save`) | – / 64.8 (n=20) | no comparable scenario | ≤ 200 | PASS |

Why the numbers are this low: the app's cold overview is a fresh browser context against a server that is already running, with its SQLite pages in the OS cache, and one server-rendered page. v5's cold overview parses one 4.5 MB HTML file from the page cache. The v5 reference's warm navigation re-renders in the page without a request, so it is faster than the app's client-side navigation (one page-data request). Both are reported, and neither is a ratio. Raw samples: `.local/GRS-21/metrics/metrics.json`.

## BA-01 to BA-21

The verdict is the owner's evidence, in a suite that passed in this gate at `2243fc3`. The second reviewer judges how deep each one goes.

| Finding | Owner | Evidence | Verdict |
| --- | --- | --- | --- |
| BA-01 | GRS-16 | `tests/calculations/interest.test.ts` (28/29 February, month-end); register `CC-06.json` lists each changed prescription label | PASS for the arithmetic. The legal rule (leap-day target, `<` or `<=`, interruption) still needs the user's approval. |
| BA-02 | GRS-16 | register `CC-06.json` entries with source BA-02: the imported note is labelled unverified beside the computed values; quantum suite | PASS |
| BA-03 | GRS-16 | `tests/calculations/interest.test.ts`; quantum suite reload and query scenarios | PASS |
| BA-04 | GRS-12 | v5 lane `dates`; `src/lib/local-case/chronology.test.ts`; `contracts.test.ts` | PASS on v5; CC-12 repeats it on the newer export |
| BA-05 | GRS-14 | evidence suite; register `CC-04.json` | PASS on v5; CC-12 part open |
| BA-06 | GRS-14 | `tests/evidence/diff.test.ts`; evidence suite | PASS |
| BA-07 | GRS-14, GRS-17 | `tests/evidence/contracts-people.test.ts`; evidence and registers suites | PASS on v5; CC-12 part open |
| BA-08 | GRS-14, GRS-19 | evidence and bundles suites; coverage counts derived from rows | PASS on v5; CC-12 part open |
| BA-09 | GRS-12 | v5 lane `routes`; `src/lib/local-case/project.test.ts` | PASS on v5 (v5 has no parent-e-mail route); CC-12 part open |
| BA-10 | GRS-19 | `tests/bundles/discovery.test.ts`; bundles suite | PASS |
| BA-11 | GRS-22 | none in v5 | not applicable to v5; CC-12 |
| BA-12 | GRS-21 | layout runs, both cases: at 320, 390, 768 and 1280 px no control overlaps a heading or another control, and no page scrolls sideways; the UI class suite's `narrow` | PASS |
| BA-13 | GRS-21 | layout runs: text contrast and component states | FAIL (F1, F2) |
| BA-14 | GRS-12, GRS-21 | layout runs: keyboard, focus and Back for all 42 views; UI class suite `back`; v5 lane 9 | PASS |
| BA-15 | GRS-14 | `tests/evidence/search.test.ts`; evidence suite | PASS |
| BA-16 | GRS-12 | `src/lib/components/titles.ts` contracts; v5 lane `contracts`; each category suite's title checks | PASS |
| BA-17 | GRS-14, GRS-16 | evidence suite (screen order against each CSV); quantum suite (prescription export) | PASS |
| BA-18 | GRS-12, GRS-21 | layout runs: each heading and title equals its registry label; v5 lane `registry` | PASS. F1 is a separate failure: the navigation calls 37 working views not yet available. |
| BA-19, BA-20 | V2 (GRS-26, GRS-36, GRS-32) | none | out of V1 scope by the register's explicit deferral |
| BA-21 | GRS-15, GRS-21 | layout runs at 320 and 390 px: no sideways scroll, wide tables in their own scroll box (UI class `narrow`); the smallest text is 10.7 px (discovery schedule), reported, not gated | PASS |

## Isolation

- **Hostile imported content:** AC8 puts script, event-handler, SVG, `srcdoc` and broken-citation payloads into 57 prose fields of the results, plus the pilot's hostile originals and rows. All 42 views and the hostile document page render inert: no script runs, no `javascript:` link, no injected element and no request leaves loopback. The payload shows as text on 16 views. A package with a `javascript:` link in a narrative field is rejected at validation (`LINK_UNSAFE_SCHEME`, error) and activates nothing.
- **Original preview:** the pilot suite (gate `test:e2e`) S13, S28 and S29 open every hostile original (HTML, SVG, text, polyglot, PDF with OpenAction, Launch or URI, EML, mislabelled PNG) through the UI: nothing runs in any frame or tab; PDF.js runs in an opaque-origin sandbox; raw PDF bytes are always attachments.
- **42-view parity, apart from other capabilities:** all 42 v5 views are compared with 0 unregistered differences. These capabilities are outside that result:
  - production-only, not in v5: the e-mail and e-mail-silence datasets (BA-11), privilege suggestions (BA-07) and sign-in (BA-19, BA-20);
  - deferred: the newer 2,131-document export (CC-12), the document-processing corrections (data-correction-deferred-to-pipeline) and V2 hosting.

## Findings

App code is outside this gate's scope; each finding goes to its owner as a follow-up.

- **F1. 37 working views are marked not available.** The view registry `src/lib/components/view-registry.ts:27` and the 36 lines after it is generated from `docs/plan/view-coverage.json`. It still gives 37 views the status `unavailable-until:GRS-14…20`, though those tickets are Done. As a result:
  - the navigation adds a hidden "(not yet available)" to each link (`src/lib/components/ViewNav.svelte:53-54`);
  - the overview's Go-to list shows "(not yet available, GRS-15)" (`src/routes/v/[vid]/overview/+page.svelte:81`);
  - the `.unavailable` link colour `#777` reaches 4.48:1 against the navigation background, below 4.5:1 (`src/app.css:25`).

  Follow-up for the coordinator: flip the statuses in the inventory, then regenerate the registry. That also clears the contrast failure.

  **Closed by GRS-67** (`086c797`): `scripts/pilot/generate-view-registry.ts` marks a view available once its owner's ticket passed (GRS-12, GRS-14 to GRS-20), so all 42 entries are `available`, and neither the navigation nor the Go-to list marks a view unavailable. The `.unavailable` colour is now `#707070`, 4.95:1 on white (was `#777`, 4.48:1). At `5d15b8b` both layout runs report 0 shell contrast failures, and the navigation link's text is 8.04:1.
- **F2. The focus indicator is 2.06:1.** The shared `:focus-visible` outline `3px solid #f0a020` (`src/app.css:5`) reaches 2.06:1 against white and 2.15:1 against the navigation background. WCAG 2.2 1.4.11 asks for 3:1. Every focusable component inherits it. Follow-up for the coordinator, who owns the shared components: use a darker outline, or a two-tone ring.

  **Closed by GRS-67** (`086c797`): the outline is `3px solid #d35400`. At `5d15b8b` both layout runs measure the ring at 3.99:1 on the page background and 4.17:1 on the navigation background, and every focusable component passes. It also reaches 3.45:1 on the dark header.
- **F3 (withdrawn). A Court Bundle overlap at 390 px.** The first layout run (`1f38aca`) compared bounding boxes, so a wrapped button looked like an overlap. Measured line box by line box at `2243fc3`, nothing overlaps.
- **F4. Source-defect dispositions are incomplete.** The register has an entry naming 47 of the 159 v5 source defects (the 18 rows of `defects.md` and the 145 per-view defects of `view-checklist.md`, with overlaps). It names neither high defect `S-rescan_tab-1` nor `S-backup_tab-1` (both fixed by GRS-20, but not registered). It has no entry of type `data-correction-deferred-to-pipeline`, so the imported-data defects `S-meta-counts` and `S-prescription-frozen` are not tagged. Follow-up for the register owners: add a disposition per defect, or record "no visible difference" with its reason, and tag the imported-data ones. [defects-table.md](defects-table.md) lists every defect. The register is outside this gate's write scope.

  **Closed by GRS-67** (`4158641`): `scripts/verify/register-dispositions.mjs` writes a disposition (an entry with `field: []`, [parity README](../../reference/parity/README.md#source-defect-dispositions)) for each of the 112 defects, under its owner. The 112 defects are in 109 entries: 72 `defect-fix`, 33 `known-gap` and 4 `data-correction-deferred-to-pipeline` (`S-meta-counts`, `S-overview-2`, `S-prescription-frozen`, `S-catalogue-refs`). Each entry cites a test or app line and has `approvedBy: null`. At `5d15b8b`, dispositions report 159 of 159 registered, and strict parity reports 0 unregistered and 0 unused out of 326 entries.

## Follow-ups and shared-file requests

- Add `acceptance` to `CATEGORIES` in `tests/e2e/pilot/run.mjs`, so `test:e2e` runs the acceptance suite. Its summary already uses the category contract.
- Rerun `scripts/verify/layout.mjs` on both cases after F1 and F2 are fixed.
- `scripts/agent-tools/doctor`: relock the three skills that drifted on this host (an environment issue).
