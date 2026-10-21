# CC-11 (GRS-21): M2 readiness gate

The gate author's evidence for complete v5 parity and local release readiness. It is not the final verdict: a fresh second reviewer reruns the critical paths at the exact revision ([reviewer-guide.md](reviewer-guide.md)) and gives the final PASS. The user's visual review uses [walkthrough.md](walkthrough.md).

- **Evidence revision:** `ede8ef8fa169a986693bbafa293478535db25c59` (GRS-21's final matrix script, FIX-21c, on this branch). The gate and every run below except the metrics were made at this revision on a clean tree. The commit after it adds only the regenerated `docs/acceptance/CC-11/` and this file.
- **Metrics revision:** `a8b8f8179469`. App code has not changed since: `git diff --stat a8b8f81 ede8ef8 -- src/` is empty, so the [Metrics](#metrics) below still describe the head and were not rerun.
- **Base:** dev `d0e4786`. This branch also carries GRS-67's changes under `src/` (F1, F2, M3, F5 below).
- **Author's verdict:** all items pass at `ede8ef8`; final PASS pending the second reviewer's re-check. F1, F2, F4 and F5 are closed on this branch (`feature/grs-67-readiness-findings`, stacked on `feature/grs-21-readiness-gate`); F3 was withdrawn.

## Commands and results at `ede8ef8fa169`

| Check | Command | Exit | Result | Output (ignored, local) |
| --- | --- | --: | --- | --- |
| Gate | `bun run --bun gate` | 0 | `GATE PASS ede8ef8fa169`: build, check, test, test:e2e (every suite PASS; UI classes 253/253), strict parity, the v5 lanes | `.local/gate/` |
| Strict parity | gate step `parity --all --strict-register` | 0 | 42 views extracted on both sides; 103,130 values compared, 99,766 matched, 3,364 registered, 0 unregistered; 0 not-yet-implemented | `.local/gate/parity-out/scorecard.md` |
| Real v5 lanes | gate step `verify:pilot:v5` | 0 | 18/18 lanes PASS | `.local/gate/v5-out/lanes-v5.json` |
| Acceptance workflow | `scripts/verify/evidence.sh acceptance` | 0 | 8/8 scenarios (AC1–AC8); AC2 compared all 10 originals' bytes with the case folder's | `.local/GRS-21/acceptance-out/acceptance/` |
| Layout, synthetic | `scripts/verify/evidence.sh layout` | 0 | 42 views × 4 widths, 8 components: 0 failures (before GRS-67: 1 shell contrast failure, F1, and 8 component failures, F1 and F2) | `.local/GRS-21/layout-synthetic/layout.json` |
| Layout, v5 sample | `scripts/verify/evidence.sh layout-v5` | 0 | 42 views × 4 widths, 8 components: 0 failures (before: `hoa_diff_tab` scrolled sideways at 320 and 390 px, F5; F1 and F2 as above) | `.local/GRS-21/layout-v5/layout.json` |
| Metrics | `scripts/verify/evidence.sh metrics` | 0 | at `a8b8f8179469`, not rerun: `src/` is unchanged since (empty `git diff --stat a8b8f81 ede8ef8 -- src/`); see [Metrics](#metrics) | `.local/GRS-21/metrics/metrics.json` |
| Dispositions | `scripts/verify/evidence.sh dispositions` | 0 | 159 of 159 defects registered, the 4 imported-data defects tagged; [defects-table.md](defects-table.md) (before: 47 named, F4) | `.local/GRS-21/dispositions.json` |
| Matrix | `scripts/verify/evidence.sh matrix` | 0 | 42 PASS, 0 FAIL, 0 BLOCKED: [matrix.md](matrix.md) | – |

`scripts/agent-tools/doctor` fails on this host, because three installed skills differ from `skills.lock.json`. That is an environment drift, not part of this branch, and no check above depends on it.

## Acceptance items

| # | Item | Verdict | Evidence |
| --: | --- | --- | --- |
| 1 | All 42 views and their actions, PASS/FAIL/BLOCKED at the reviewed revision; no placeholder passes | PASS for all 42 views | [matrix.md](matrix.md): strict parity compared all 42 with 0 not-yet-implemented entries, and every view has passing browser scenarios. Every matrix input carries this revision. |
| 2 | Offline import-to-original workflow, then edit, restart, backup, restore and activate a replacement without losing user work | PASS | acceptance AC1–AC7, offline in a network namespace with only `lo` |
| 3 | Keyboard and focus, Back, labels, contrast, layouts at 320/390/768/1280; screenshots and walkthrough | PASS | Keyboard, Back, labels, overlap, sideways scroll and contrast pass for all 42 views at all four widths, on both cases, and for the 8 components. Screenshots are indexed in [walkthrough.md](walkthrough.md). |
| 4 | Interleaved reference/head metrics and absolute budgets; known-data defects reviewed; user visual review requested | PASS for the metrics and the defects; visual review open | [Metrics](#metrics); [defects-table.md](defects-table.md); the visual review is the user's |
| 5 | Second reviewer reruns critical paths | open | not the author's: [reviewer-guide.md](reviewer-guide.md) |
| 6 | `docs/development.md` extended after CC-03 | PASS | section "M2 readiness checks (GRS-21, CC-11)" and the updated known limits |
| 7 | `docs/user-guide.md` extended after CC-10 | PASS | "Windows quick start" (GRS-64): WSL2 only, native Windows stated as unsupported, three parts marked unverified |
| 8 | BA-01 to BA-21 dispositions reviewed against owners | PASS | [BA review](#ba-01-to-ba-21) |
| 9 | Hostile imported content and original-preview isolation; parity reported apart from production-only and deferred capabilities | PASS | AC8 and the pilot suite's S13/S28/S29; [Isolation](#isolation) |
| 10 | BA-12, BA-13, BA-14, BA-21 verified by this gate | PASS | layout runs on both cases, 0 failures. |
| 11 | Backup-and-restore round trip for every store on CC-10's coverage list | PASS | AC5: each of the 21 stores and the notes equal after a restore into a clean profile; `tests/system/stores-21.test.ts` (gate `test`) |
| 12 | Every v5 source defect has a register disposition; imported-data defects tagged `data-correction-deferred-to-pipeline` | PASS | F4 closed: 159 of 159 registered |

## Verification steps 1–10

| Step | Verdict | Evidence |
| --- | --- | --- |
| 1. Reference and rewrite side by side | PASS | strict parity, 42 views; v5 lane 1 |
| 2. Every view and meaningful action | PASS for all 42 views | [matrix.md](matrix.md) |
| 3. All citations and original mappings | PASS | AC2: every document of the synthetic case resolves to bytes whose sha256 equals the case-folder original read from disk (10 of 10 compared), and one opens in the viewer; v5 lanes 5, 6, 7, `routes`, `pages` |
| 4. Fixed search and numeric examples | PASS | v5 lane 4; parity (the search and quantum views compare every value); the quantum suite |
| 5. Edit every mutable state category, then restart | PASS | AC3 (every form and every non-form save of every page; 21 stores and notes hold rows), AC4 |
| 6. Backup and restore into a clean profile | PASS | AC5 |
| 7. A failed import keeps the previous case active | PASS | AC6 (an altered package is rejected and user work is unchanged); v5 lane 8 |
| 8. Fully offline | PASS | every suite and script runs in a network namespace with only `lo` and proves it first; v5 lane `isolation` |
| 9. Keyboard, contrast and four viewport widths | PASS | layout runs, both cases: 0 failures |
| 10. 30–60 s walkthrough and the differences register | open | [walkthrough.md](walkthrough.md) for the user's review; the register has 326 entries, all `approvedBy: null` |

## Metrics

Measured at `a8b8f8179469` on this host (20 cores, 15 GiB), offline, with the production build under Bun. Each metric has 20 kept samples after 2 warm-up samples, and percentiles are nearest-rank. Cold overview and warm navigation alternate sample by sample between the v5 reference and the head, in the same browser; the reference column is reported beside the head's, with no ratio. Search and state write have no comparable v5 scenario. Search is a server round trip in the app and an in-page filter in v5; state write saves to SQLite in the app and to localStorage in v5. They are gated on their absolute budgets only.

| Metric | Scenario | Head p50 / p95 ms | v5 reference p50 / p95 ms | Budget p95 ms | Verdict |
| --- | --- | --- | --- | --: | --- |
| Cold overview | fresh browser context: navigation start to the overview rendered, then the next frame | 100.3 / 108.9 (n=20) | 123.4 / 135.3 (n=20) | ≤ 2000 | PASS |
| Warm navigation | one warm tab: a click on Chronology to the chronology rendered, then the next frame | 80.1 / 88.3 (n=20) | 17.7 / 18.3 (n=20) | ≤ 200 | PASS |
| Search | `measure --ticket CC-04`: a click on Search to the results rendered, on the v5 sample | – / 34.5 (n=20) | no comparable scenario | ≤ 300 | PASS |
| State write | `measure --ticket CC-07`: a click on Save to the row rendered, 500 rows per register; worst of 7 registers | – / 60.1 (n=20) | no comparable scenario | ≤ 200 | PASS |

Why the numbers are this low: the app's cold overview is a fresh browser context against a server that is already running, with its SQLite pages in the OS cache, and one server-rendered page. v5's cold overview parses one 4.5 MB HTML file from the page cache. The v5 reference's warm navigation re-renders in the page without a request, so it is faster than the app's client-side navigation (one page-data request). Both are reported, and neither is a ratio. Raw samples: `.local/GRS-21/metrics/metrics.json`.

## BA-01 to BA-21

The verdict is the owner's evidence, in a suite that passed in this gate at `4a6b9a5`. The second reviewer judges how deep each one goes.

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

App code is outside this gate's scope; GRS-67 closed F1, F2, F4 and F5.

- **F1. 37 working views are marked not available.** The view registry `src/lib/components/view-registry.ts:27` and the 36 lines after it is generated from `docs/plan/view-coverage.json`. It still gives 37 views the status `unavailable-until:GRS-14…20`, though those tickets are Done. As a result:
  - the navigation adds a hidden "(not yet available)" to each link (`src/lib/components/ViewNav.svelte:53-54`);
  - the overview's Go-to list shows "(not yet available, GRS-15)" (`src/routes/v/[vid]/overview/+page.svelte:81`);
  - the `.unavailable` link colour `#777` reaches 4.48:1 against the navigation background, below 4.5:1 (`src/app.css:25`).

  Follow-up for the coordinator: flip the statuses in the inventory, then regenerate the registry. That also clears the `.unavailable` contrast failure. The second review's M2: the check used to list only 20 failing elements per page, which hid one case. On its own page, an unavailable view's *current* link is `#777` on the navy `rgb(29,43,58)`, 3.21:1 (`src/app.css:25` against the `aria-current` style), and the report now lists all of them (74 text elements). A darker grey for white makes the navy case worse, so the fix must cover both.

  **Closed by GRS-67** (`de6561b`, M3 at `a8b8f81`): `scripts/pilot/generate-view-registry.ts` marks a view available once its owner's ticket passed (GRS-12, GRS-14 to GRS-20), so all 42 entries are `available`, and neither the navigation nor the Go-to list marks a view unavailable. The `.unavailable` colour is `#707070`, 4.95:1 on white (was `#777`, 4.48:1). The second review's navy case is closed too: `nav.views a.unavailable[aria-current='page']` keeps white text, so the current link of an unavailable view is 14.39:1 on the navy (it was 2.91:1 with `#707070`; probe `scripts/verify/nav-unavailable-probe.mjs`, which marks a link unavailable and current in Chrome). Before: 74 failing text elements with `#777`; after, layout runs report 0 shell contrast failures.
- **F2. The focus indicator is 2.06:1.** The shared `:focus-visible` outline `3px solid #f0a020` (`src/app.css:5`) reaches 2.06:1 against white and 2.15:1 against the navigation background. WCAG 2.2 1.4.11 asks for 3:1. Every focusable component inherits it. Follow-up for the coordinator, who owns the shared components: use a darker outline, or a two-tone ring.

  **Closed by GRS-67** (`de6561b`): the outline is `3px solid #d35400`. Both layout runs at `ede8ef8` pass every focus check; the ring measures 3.99:1 on the page background and 4.17:1 on the navigation background (it was 2.06:1 and 2.15:1), and 3.45:1 on the dark header.
- **F3 (withdrawn). A Court Bundle overlap at 390 px.** The first layout run (`6b70c69`) compared bounding boxes, so a wrapped button looked like an overlap. Measured line box by line box at `0808ce2`, nothing overlaps.
- **F4. Source-defect dispositions are incomplete.** The register has an entry naming 47 of the 159 v5 source defects (the 18 rows of `defects.md` and the 145 per-view defects of `view-checklist.md`, with overlaps). It names neither high defect `S-rescan_tab-1` nor `S-backup_tab-1` (both fixed by GRS-20, but not registered). It has no entry of type `data-correction-deferred-to-pipeline`, so the imported-data defects `S-meta-counts` and `S-prescription-frozen` are not tagged. Follow-up for the register owners: add a disposition per defect, or record "no visible difference" with its reason, and tag the imported-data ones. [defects-table.md](defects-table.md) lists every defect. The register is outside this gate's write scope.

  **Closed by GRS-67** (`4158641`, fix round `9334ab5`): `scripts/verify/register-dispositions.mjs` writes a disposition (an entry with `field: []`, [parity README](../../reference/parity/README.md#source-defect-dispositions)) for each of the 112 defects it covers, under its owner, in 109 entries: 66 `defect-fix`, 39 `known-gap` and 4 `data-correction-deferred-to-pipeline`. Six partial fixes are `known-gap` (rule: `defect-fix` only when no part of the defect remains). A rerun keeps an approval, and `--check` fails on a defect with no entry, a stale disposition or an empty evidence pattern. Every entry has `approvedBy: null`. Dispositions report 159 of 159 registered (before: 47), and strict parity 0 unregistered.

- **F5. `hoa_diff_tab` (Document Diff) scrolls sideways at 320 and 390 px on the v5 sample.** Content and layout viewport are 422 px wide against the requested 320 and 390. The synthetic case does not overflow, so the long document names of the real sample cause it. Cause: the two document selects are in a flex row with `.row .in { max-width: 28rem }` (448 px) and no `max-width: 100%` (`src/routes/v/[vid]/evidence/hoa_diff_tab/+page.svelte:48-49`, selects at `:22-23`). The earlier runs passed this view because the check compared the page width with the browser's own layout viewport, which grows with the overflow. Affects BA-12 and BA-21 and the matrix row `hoa_diff_tab`.

  **Closed by GRS-67** (`a8b8f81`): confirmed before the fix: at 320 and 390 px `div`, the label and `select#diffA` / `select#diffB` end at 422 px. A select is as wide as its longest option, and its flex cell (`min-width: auto`) could not shrink below it, so `max-width: 28rem` alone capped nothing. The cell now has `min-width: 0` and the select `max-width: min(28rem, 100%)`. The same shape elsewhere is capped: the register form's wide field (`min-width: 16rem`), the court bundle filters (`230px`) and the shared `.grid` track (`260px`) use `min(…, 100%)`. After: `layout-v5` at 320, 390, 768 and 1280 px reports 0 failures.

## Evidence soundness

The second review (`EVIDENCE UNSOUND` at `76f0773`) found checks of this gate that passed without proving their claim. Each is fixed, with a failing probe before and a pass after:

- **AC2 bytes (H1).** The expected bytes came from the results package's files, so nothing was compared and the check passed by default. They now come from the case folder on disk, and AC2 fails unless every opened original has a sha256 match and at least one was compared. Probe: every expected original plus one byte fails AC2 (`bytes: false`, 0 of 10 matched).
- **Sideways scroll (H2).** Under mobile emulation Chrome widens the layout viewport to fit overflowing content, so `scrollWidth > innerWidth` could not fail. The check now compares with the requested width. Probe: `main` forced to 360 px at 320 px fails (`content 395, layout viewport 395, requested 320`); it also found F5.
- **Matrix revision (M1).** Inputs now carry their revision (`scripts/verify/stamp.mjs`: the acceptance and layout results stamp HEAD, tree state and the build's revision; the gate's e2e summary and parity scorecard already did). The matrix BLOCKS every view and exits 1 when any input, or the build, is missing, unstamped, dirty or for another SHA, or when an acceptance scenario is missing. Probe: `--sha 0000…` gives 42 BLOCKED.
- **Sweep.** The same shape elsewhere in `tests/e2e/acceptance/` and `scripts/verify/` is fixed too: the AC3 edit results, AC7 row contents, a page that fails to load in AC3, the contrast report's cap and unparsed colours, a component state with no measured contrast, the overlap check's old 400-control cap, the metrics reused-run exit codes and stale files, and the dispositions' unknown or unparsed rows. The fix report lists each site.

## Follow-ups and shared-file requests

- Add `acceptance` to `CATEGORIES` in `tests/e2e/pilot/run.mjs`, so `test:e2e` runs the acceptance suite. Its summary already uses the category contract.
- `scripts/agent-tools/doctor`: relock the three skills that drifted on this host (an environment issue).
