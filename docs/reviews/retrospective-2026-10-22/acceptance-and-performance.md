# Acceptance and performance retrospective

Review date: 22 October 2026. Reviewed source: `dev` at `225b7e00578319d16383678a8d1ae6efb362a0ba`, checked out on `audit/retrospective-2026-10-22`.

This is a **static review, with runtime acceptance UNRUN**. No build, install, test suite, gate, browser, original, private locator, credential or production system was accessed. The parent reported that doctor, invoked through Git Bash on Windows, refused with `unsupported OS 'msys'`; this review does not manufacture a replacement receipt. Historical PASS statements below describe the scope of recorded evidence, not a rerun at the reviewed SHA. Only this report was written. No skills or additional agents were invoked.

## Assessment

The tests contain substantial behavioral coverage. The useful work is in assertions about stored identities and values, real refused writes, retries, conflicts, process restarts, export contents and citations. Counting files, scenarios or all 42 view names would understate that work and overstate acceptance in other places.

The most actionable new finding is that performance and layout readers do not consistently wait for incremental table completion. The acceptance edit sweep also has weaker success criteria than the existing shared UI-class suite. Finally, the usual gate does not execute several of the strongest integrated readiness checks. These are P2 measurement/assertion/coverage gaps; this review establishes no P0/P1 application failure or measured budget violation.

Production-browser journeys and latency for the newer and JSON generations, richer hosted viewers and non-Chromium/device evidence are already recorded residual work. They must remain separate from new findings and from the local v5 result.

## Findings

### AP-01 — P2: table timing and layout can finish before the table does

**Classification:** new measurement and assertion gap; not a finding that the current app exceeds its budget. **Confidence: high** in the predicate mismatch; actual timing and visual consequences were not measured.

**Evidence at the reviewed SHA:**

- `src/lib/components/DataGrid.svelte:13-26` renders 150 rows initially, adds up to 400 per animation frame and exposes `data-complete`.
- `src/routes/v/[vid]/chronology/+page.svelte:45-49` sets the chronology ready marker on mount. Its `#row-count` describes the full filtered list, independently of how many grid rows have rendered.
- `scripts/verify/metrics.mjs:69-78` stops the chronology timer when that marker and `#row-count` exist, followed by one animation-frame/task boundary. `scripts/measure/cc03.mjs:172-176` additionally checks the count's text/value, but also omits table completion.
- `scripts/verify/layout.mjs:144-156` waits for readiness and two frames before measuring each viewport. `tests/e2e/classes/suite.mjs:544-578` similarly measures after the generic open/settle and ready wait, without requiring `data-complete`.
- A correct reusable precedent exists in `scripts/parity/lib/browser.mjs:113-114`: `p.settled()` waits until no incremental grid reports `data-complete="false"`, then waits two frames. `scripts/parity/adapters/app/_shell.mjs` uses this when opening a view.

**Trigger and impact:** a chronology with more rows than fit in the initial render, especially a larger synthetic/newer/JSON list or a delayed later render. At 1,689 rows, completion needs four growth callbacks; a single post-ready frame is not a guarantee that all four ran. A regression that delays later rows can leave the measured warm-navigation p95 unchanged. A viewport measurement can inspect a prefix and miss a later row's overflow or controls. This matters because the report calls the endpoint “chronology rendered,” rather than explicitly measuring only first usable content.

**Smallest fix:** define one shared readiness expression for these readers: the intended view is ready, its expected count is correct, and all grids in the measured main are complete. Use it for the complete-table metric and before layout/contrast/screenshots. If first usable content is also useful, retain it as a separately named metric; do not silently reinterpret the existing numbers as full rendering. Keep the existing post-frame mark.

**Targeted validation:** use one synthetic chronology larger than 950 rows. Delay a later growth callback and require the complete-table mark to remain unset; then release it and require the last row and expected count before marking. Put a deliberate overflow or low-contrast sentinel in a late row for a layout negative control. One shared readiness check and one integration control are enough; no second parity engine is needed.

**Incoming:** the relevant readers and grid are unchanged by `a3f80d1305294a8c685a87351281eef7928c7d9c`. The changes introduced on the guard-followups branch do not add this completion condition.

### AP-02 — P2: AC3 can count an attempted action as a saved action

**Classification:** new acceptance assertion gap, partly mitigated by stronger category/UI-class tests. **Confidence: high** in the acceptance predicate; no failing application action was executed.

**Evidence at the reviewed SHA:**

- `tests/e2e/acceptance/suite.mjs:246-252` marks a form edit successful after click/quiet completes and no visible alert/error is found. It does not inspect that action's result or compare the submitted values with a resulting row.
- Its non-form `drive` helper at `:258-261` uses only `error === null`, and records `alerts: []` without inspecting alerts.
- `:293-299` verifies nonempty rows in all 21 mapped stores plus notes, then aggregates observed actions. `if (!e.disabled)` excludes an action whose submit remained disabled from the final failed-action set. This contradicts the nearby comment's intended requirement that a permanently disabled submit is not an edit.
- In contrast, `tests/e2e/classes/suite.mjs:201-227,267-280,329-365` observes the held request's result and a persisted effect. `tests/e2e/classes/verdicts.mjs:11-48` rejects a SvelteKit failure carried in HTTP 200, and requires the effect for the success path. Its synthetic values have a per-call serial (`suite.mjs:100-105`), preventing earlier saves from satisfying later checks.

**Trigger and impact:** an action becomes a silent no-op, writes a wrong/default value, returns a failure without the tested error markup, or is permanently disabled while another action has populated the same store. The acceptance sweep can label that action saved as long as aggregate store occupancy remains satisfied. The subsequent restart/restore comparisons faithfully preserve whatever was stored; they do not establish that each earlier requested edit was correct. The existing category suite may catch a particular regression, so this is specifically a weakness in AC3's claimed action coverage, not evidence that the full gate currently misses every such fault.

**Smallest fix:** reuse the existing action-result/effect approach instead of introducing another generic form framework. Keep disabled actions in the required action inventory unless an explicit, checked inapplicability reason covers them. Give the handful of non-form drivers a concrete expected row/value or visible persisted outcome and an error check. A full per-field oracle for every form is unnecessary.

**Targeted validation:** with synthetic observations, make one observed action permanently disabled and another successful in the same store; AC3 must fail the disabled action. Make a driven save answer without persisting its expected value; it must fail even if that store already has rows. Preserve the existing success case and 21-store round trip. These are assertion controls, not grounds for a new giant browser suite.

**Incoming:** neither incoming branch introduces this correction. The proof wave does not change this suite; inspect guard-followups relative to its merge base, not as if its older app tree replaced current dev.

### AP-03 — P2: metrics aggregation does not validate its own evidence identity

**Classification:** new evidence-validation gap in the optional metrics runner. **Confidence: high** in the missing checks; medium in operational exposure because the normal outer invocation already provides useful protections.

**Evidence at the reviewed SHA:** `scripts/verify/metrics.mjs:46-61` normally clears child output directories and runs CC-04 and CC-07 anew, before re-executing offline. This is a positive control. However, `:86` only records `revisionStamp(ROOT)` for its own `./build` measurements. At `:143-150`, reused results are admitted on stored child exit 0 and file existence, and metric objects are found recursively by path substring. Their `evidence`, actual build revision and consistency with the directly measured build are not checked. The final PASS predicate at `:154-162` tests sample count and p95 only. The file does not use the shared `freshness`/`evidenceRecord` checks.

**Trigger and impact:** entry into the offline half with old `reused.json`/child results, or a checkout/build transition between the child and direct measurements, can combine metrics from different revisions. The aggregate can print PASS for the numbers without establishing one exact eligible revision. The regular outside-namespace call, on an unchanged checkout, is much safer: child measurement wrappers check freshness and the outer phase replaces old files. Do not describe this as a demonstrated bad historical run.

**Smallest fix:** record a run identity and expected source/build SHA before launching children; require the children and own build to match it, with evidence true and no reduction/abort. Reuse the existing freshness helper, and recheck identity at the end. Read named search/register-save fields rather than accepting arbitrary similarly named p95 objects. Keep the normal clear-output behavior.

**Targeted validation:** extract only the small aggregate-input validator. Present it with a valid current result, an old-SHA result, `evidence: false` with exit 0, a missing register series, and a direct build stamped with another SHA. Only the first complete set qualifies. This is preferable to rerunning real-v5 measurements for every malformed-summary control.

**Incoming:** GRS-161's guard-followups changes sanitize Git reads in measurement entry points and identity helpers. That is related provenance hardening already tracked as **In Review**, not this aggregate's result-validation fix. Neither inspected incoming branch changes `scripts/verify/metrics.mjs`.

### AP-04 — P2: routine green gates omit the integrated readiness checks

**Classification:** documented coverage/workflow gap, newly prioritized here; not an undisclosed implementation bug. **Confidence: high.**

**Evidence at the reviewed SHA:** `scripts/gate.mjs:103-110` runs build, check, unit tests, category/pilot e2e, strict v5 parity and the real-v5 pilot. `tests/e2e/pilot/run.mjs:37-41` lists seven categories and omits `acceptance`. `docs/development.md:419-430` explicitly says that the acceptance suite, layout runs, performance metrics and matrix are outside the gate. `scripts/verify/evidence.sh:24-35` provides their separate wrapper.

**Trigger and impact:** a later change regresses a cross-store backup/replacement interaction, text/focus contrast, or a performance budget while its ordinary behavior/parity remains correct. The normal gate can stay green because it never runs the relevant readiness check. There is overlap: category suites already test many failures and restarts, and system/unit tests exercise backup contracts. The missing increment is the composed all-store UI journey and measured/visual requirements, not “no backup tests.” GRS-21 is Done; no new continuous enforcement is established merely by that historical milestone result.

**Smallest fix:** make the existing readiness wrapper a required exact-SHA release/wave acceptance step, with explicit machine-readable results, rather than duplicating it in another suite. Decide whether to add the synthetic integrated journey to routine `test:e2e`; keep expensive real-v5 layout/measure work at the acceptance boundary if the measured cost justifies it. Record that boundary in one current checklist so ordinary gate PASS is not mistaken for current release readiness.

**Targeted validation:** demonstrate that the required acceptance command rejects one synthetic cross-store round-trip fault and one deliberately over-budget metric. Reuse the existing AC5 equality checks and metric validator. Run them once at the integrated release SHA on the supported Linux environment; this review does not supply that evidence.

**Incoming:** proofs-final adds identity-workspace installation, root test collection and hosted probe checks, but does not add these local readiness steps. Those are useful incoming improvements and do not close this gap.

## Assertion and evidence boundaries worth preserving

| Layer | Valuable evidence | Boundary/limit |
| --- | --- | --- |
| Root unit/route tests | Exact calculation results, identities, anchors, validation/refusal behavior, real scratch SQLite transactions; route loaders and SSR rendering in selected tests | A loader/render test with `$app/forms`/navigation mocks is a component or contract test. It is not a completed hydrated-browser journey. Example: `tests/case-package/newer-analysis-views.test.ts:23-24` deliberately mocks these client seams. |
| Category e2e | Production local app, real browser input, persisted values, restart/retry/conflict checks and format-specific export assertions | CDP holds/fails requests to create faults. This is useful fault injection against a real write path, not a mocked success at the acceptance boundary. |
| Shared UI classes | Source discovery, checked inapplicability reasons, distinct synthetic values, successful action result plus stored effect; many pages get the same regression class | Blob CSV capture replaces the anchor click and reads the Blob (`tests/e2e/classes/suite.mjs:91-95`). It proves generated contents/formula neutralization, not that the browser downloaded a file. Keep real-download checks in the category journeys. |
| Strict parity | All 42 app adapters, reference/app extraction, control inventory, export comparisons, UI sweeps plus broader engine sweeps | Equal outputs can preserve a source defect. Intentional-difference dispositions and separate business assertions remain necessary. Engine sweeps prove libraries; UI sweeps prove controls. |
| Comparator mutation unit tests | `tests/parity/mutations.test.ts` alters snapshots and proves that comparison/classification exposes differences with register entries in force | These do not show that a source-code mutation reaches a browser adapter. The separate `scripts/parity/mutate.mjs` scratch-build exercise is the appropriate check for that boundary. No need to run it on every cosmetic change. |
| Real-v5 pilot | Actual 1,689-row import/activation, chronology/filter examples, citations/PDF, missing originals, rejected candidate, keyboard/Back, offline restart | Not a 42-view action-by-action acceptance verdict for another generation or the hosted production backend. |
| Hosted gate | Native local workerd, fixture-backed local D1/R2, real artifact/import guards and denial paths | `scripts/gate-hosted.mjs:69-76` expressly names identity/store/assets/audit doubles and unavailable production capabilities. GRS-137's complete workflow remains separate. |

The freshness/reduced-run safeguards in `tests/e2e/pilot/lib/fresh-build.ts`, category summary validation in `tests/e2e/pilot/run.mjs:89-120`, and partial-evidence refusal in `scripts/verify/matrix.mjs:90-147` are strengths. GRS-68's crashed/partial matrix-input fixes are present; do not reopen the old failure as if it were unfixed.

Two reporting qualifications also matter:

- `scripts/verify/matrix.mjs:175-219` assigns a view verdict from parity, named scenarios and layout, then applies it to that view's listed actions. The generated rule expressly says it does not map each action to a scenario. This is a useful inventory but is not proof that every action's effect was tested. Add stable action IDs only for meaningful uncovered mutations, exports and alternate states; do not create a duplicate test for every label.
- `scripts/verify/matrix.mjs:229` returns nonzero for evidence problems or BLOCKED views, but not for FAIL views. `tests/gate/matrix.test.ts:125-131` explicitly pins successful generation of a matrix containing a layout FAIL. Treat it as a report generator. `evidence.sh` normally retains earlier failing step exits, but its `matrix`-only mode can finish successfully with FAIL rows. If this becomes an acceptance command, add an explicit strict-verdict mode or validate totals; do not quietly change the existing report-generation contract.

## Coverage of all 42 views

This is source coverage, not a fresh 42-view PASS. Counts and ownership come from `src/lib/components/view-registry.ts:25-67`; routine summary checks require each implemented category view to be named. The proposed increments deliberately reuse existing scenarios.

| Views | Meaningful existing checks inspected | Highest-value increment |
| --- | --- | --- |
| **2 pilot views:** `overview`, `chronology` | Pilot main-flow/shell/durability suites; real-v5 lanes; overview slot assertions; chronology filter/sort/export sweeps and first-document keyboard navigation | AP-01 completion mark and late-row control; keep the header count separate from rendered row count. |
| **7 evidence views:** `documents`, `contracts_tab`, `filings_tab`, `search`, `people`, `entity_ledger_tab`, `hoa_diff_tab` | `tests/e2e/evidence/suite.mjs`: pagination/filter URLs and Back, correct page-data scope, contracts/identity disclosures, filing writes and delete confirmation, search results/exports, selected diff pairs and reload | One production-browser path per newer/JSON generation that submits search, follows a direct/parent source and returns with filters. Reuse the existing evidence driver and exact expected refs. |
| **7 analysis views:** `matter`, `timeline`, `contradictions_tab`, `risk_matrix_tab`, `vdm_matrix_tab`, `info_required_tab`, `witness_tab` | `tests/e2e/analysis/suite.mjs`: authored narrative order and citations, phase/event shape, print/PDF, export columns, narrow risks, failed/queued checkbox saves across cases, restarts, empty datasets and absent view-content | In the newer/JSON browser slice, assert a few independently specified mapped values and the disclosed unsupported states. Add keyboard-only completion of a checkbox/retry/citation flow, not another full 7-view smoke loop. |
| **6 quantum views:** `quantum_tab`, `invoice_ledger_tab`, `prescription_tab`, `interest_calc_tab`, `payments_tab`, `settlement_tab` | `tests/e2e/quantum/suite.mjs` and `r2.mjs`: exact ledger values and differences, leap/month-end calculations, input refusal, persistent defaults, payment identity/order/restarts, filtered export, same/unlike interest bases and payment disclosure | Preserve GRS-173's actual comparison/no-comparison assertions. For compatibility, exercise changed defaults and one calculation in the browser using an independent numeric expected result. |
| **7 register views:** `disbursements_tab`, `timesheet_tab`, `deadlines_tab`, `privilege_tab`, `popia_tab`, `annotations_tab`, `transcriptions_tab` | `tests/e2e/registers/suite.mjs`: create/edit same ID, deleted row identity, money/countdowns, calendar/CSV contents, refs and full text, busy/transport failures, retry, no JS, in-flight and leave guards, restart | Keep the shared class suite; extend AC3 only with action-effect checks. Use the composed AC5 all-store restore rather than seven new restore journeys. |
| **7 litigation views:** `conflict_tab`, `enforcement_tab`, `legality_tab`, `elements_tab`, `authorities_tab`, `heads_tab`, `crossexam_tab` | `tests/e2e/litigation/suite.mjs`: navigation/focus, roadmap content and stable status keys across reordering, conflict checks, source-linked read views, authority/submission/cross-exam work and failure behavior | A keyboard-only add/refusal/retry and confirmed destructive action using one representative register; retain owner-specific seed/overlay checks where generic classes cannot express them. |
| **3 bundle views:** `discovery_tab`, `court_bundle_tab`, `caselines_tab` | `tests/e2e/bundles/suite.mjs`: linked/unindexed source distinctions, selection and marks, persisted mode/header, page search and citations, actual PDF/DOCX contents/order/links, build/save/restart, conflicts and stalled reload recovery, destructive confirmation | Keep GRS-175's confirmed-action server and UI negatives. Reuse the builder journey for a real downloaded export and independently read page/text order; do not substitute the Blob CSV hook for this. |
| **3 system views:** `rescan_tab`, `backup_tab`, `manual` | `tests/e2e/system/suite.mjs`: additions/changes/missing originals, unchanged scans, fresh-profile restore, refused/truncated/altered/wrong-case/large backups, no-JS/in-flight restore, manual link sample and restart behavior | Make the existing integrated all-store journey a required acceptance artifact, and preserve wrong-case/altered backup controls. |

The sum is 42. Naming a view or opening its destination is a coverage prerequisite, not the assertion of its business outcome.

## Compatibility: existing residual work, not new duplicate tickets

Connector reads on 22 October returned **GRS-22 Done** and **GRS-24 In Progress**. The current source and `docs/acceptance/CC-25/report.md:39,59,87-98` already distinguish the following:

- v5: 1,689 rows and the established browser/parity path.
- Newer: 2,131 rows, explicitly detected format, counted dataset inventory, analysis-module mapping, source/parent routes, text-cap diagnostics and fingerprint-based anchoring.
- JSON script: its own 4,466-row inventory, not an assumed copy of the newer export.
- `tests/acceptance/CC-25/real/render.ts:1-13,40-56,100-142` uses application routes in a Vite dev server for SSR markup checks. It does not execute the production build's hydrated UI or open a newer/JSON original in the viewer.
- The CC-25 report explicitly leaves production-browser journeys and overview/navigation/search latency for newer/JSON unrun. Conversion/validation/RSS numbers are single-run separate-corpus baselines, not p95 interaction budgets or speedup ratios.
- Unsupported residual datasets are retained and disclosed, not implemented views. Newer timeline phases, anchors and organogram, and the unshown contradiction checks, must not be promoted to presentation coverage by an inventory count.

**Minimum completion package for GRS-24:** retain the current conversion/contract inventories, then add one reusable production-browser sequence parameterized by generation. For each generation, import/acknowledge/activate; assert exact row count and a few independently selected mapped fields; submit a real search; follow a direct original and a parent/attachment route where present; verify original bytes and location; create one note, switch versions and establish the fingerprint result; return with browser Back. Existing v5 full parity remains its own unchanged check. Keep real material and artifacts local on the supported host. This fills the missing browser boundary without cloning all 42 category suites three times.

Run overview/navigation/search measurements for the two additional corpora with at least 20 retained samples after warmup and the existing 2,000/200/300 ms budgets, reporting each corpus independently. Keep state-write's 200 ms requirement on its comparable register fixture. Do not compare unlike corpus sizes as a speedup.

**Maintenance note, not a confirmed failure:** `real/render.ts:54` still calls `vite.ssrLoadModule`, whereas the current `src/lib/local-case/ssr-pages.test.ts:30` uses `vite.environments.ssr.runner.import` and `docs/development.md:406` directs Kit 3 tests to that API. Check this at the next authorized GRS-24 rerun and align with the working helper if necessary. This static review does not claim the old call necessarily fails in this path. Vite's official [Environment API runtime guide](https://vite.dev/guide/api-environment-runtimes) describes the environment/runner model; repository behavior remains the decisive evidence.

## Viewer formats, browser coverage and accessibility

The format evaluation is carefully bounded. `tests/viewer-evaluation/README.md:3-27` says it is a separate workspace, not part of the root gate, using synthetic files in its own protected shell. `docs/acceptance/viewers/coverage-matrix.md:1-12` identifies the evaluated browser and explicitly holds Firefox, WebKit and real mobile devices. `docs/acceptance/viewers/contract.md:161-185` transfers integration to GRS-120 through GRS-123. Connector reads confirmed **GRS-97 Done**, **GRS-120 Backlog** and **GRS-137 Backlog**. A component evaluation is therefore not missing production implementation masquerading as completed scope, provided these boundaries remain visible.

| Family | Existing evaluation value and limits | Small integration proof to retain under its owner |
| --- | --- | --- |
| PDF/images/text | Exact page/label targets and refusal, safe active-content handling, OCR/prepared page mappings, large PDF/image tiers | Use the real authorized asset route, prove bytes and supplied location, deny a stale/wrong version, verify the document is readable before readiness. Preserve the local PDF isolation path separately. |
| Word/workbooks | Prepared Word PDF fidelity; workbook stored values, hidden content, absent formula results and raw CSV; visual supplements cannot become value authorities | Assert an original workbook's hidden sheet and missing result through the shipped reader. Prove rendition version/page mapping and prepared Word content. The standalone harness's success cannot supply production authorization/readiness evidence. |
| EML/MSG | Headers/body/CID and nested attachment graphs, sanitization, Outlook/Gmail-shaped fixtures | Open the message then the selected nested attachment through protected production delivery, with provenance and exact attachment identity. Modelled Gmail shapes are not provider-export provenance. TNEF companion clearance remains unevaluated in the matrix. |
| Media | Playback/seeking on evaluated codecs; prepared AVI path; meaningful multi-track failure; large duration tier | Exercise the accepted codec/rendition on actual target browsers and asset/range delivery. HEVC and several truncated non-BMFF formats are explicitly unevaluated; do not broaden support by inference. |
| ZIP/contained files | Traversal/encryption/CRC/bomb/refusal controls, nesting/aggregate budget, duplicate-name ambiguity, content-based classification | Traverse a contained file and preserve original/member identity through production authorization and reader selection. Preserve refusal at actual limits; reduced-cap expansion checks do not prove 512 MiB/10,000-item behavior. ZIP64/split archives are explicitly unevaluated refusals. |

Scale figures in `coverage-matrix.md:118-132` are useful single-host component observations, not 20-sample production p95 or total end-to-end memory guarantees. The 1m-cell parse/ready result warrants a bounded main-thread responsiveness check when that reader ships; it does not establish a current ClearCase production regression.

Accessibility coverage is better than a screenshot-only claim: the pilot actually Tabs through navigation (`tests/e2e/pilot/suite/shell.mjs:61-77,133`), real-v5 lane 9 reaches the first chronology link and tests Back, classes check labeled/focusable scroll regions, layout measures contrast and states, and viewer checks exercise Tab entry/Escape return. Preserve these checks.

The remaining gap is **complete task operability and semantics**, not the absence of any keyboard test. `scripts/verify/layout.mjs:182-190` programmatically focuses the chosen navigation entry, so its 42-view keyboard result does not by itself cover Tab order or each form's controls. No inspected suite establishes a screen-reader task result, complete accessible-name/error association coverage, zoomed task completion or the production viewer's complete control operation across the held browsers. W3C's [Keyboard criterion explanation](https://www.w3.org/WAI/WCAG22/Understanding/keyboard.html) concerns all functionality; its [evaluation guidance](https://www.w3.org/WAI/test-evaluate/) explains why tools need knowledgeable human evaluation. Viewport/device settings are emulation parameters, as the official [Playwright emulation guide](https://playwright.dev/docs/emulation) describes; they do not turn Chromium results into Safari/device evidence.

Use a small shared task set: open/import a case, search and follow a citation, add/refuse/retry a note or register row, confirm/cancel a destructive action, and operate a published viewer including return focus. Assert names, focus order, error association and announcements at those state transitions. Add automated semantic scans to the existing pages if useful, then a human screen-reader/zoom pass. Parameterize the core tasks across Chromium, Firefox and WebKit; retain actual iOS Safari/Android checks under the existing viewer/release owners. Do not multiply every existing fault-injection combination across every browser before the basic cross-engine paths work.

## Performance: what the numbers can and cannot say

The measurement design has several strengths: nearest-rank percentiles, explicit warmup, at least 20 samples enforced by the CC-04/CC-07 runners, browser click timestamps, rendered-frame marks, side-by-side alternating reference/head samples for comparable navigation, and absolute budgets when v5 has no comparable server/storage operation. CC-04 also checks page-data body size against the chronology list, protecting against shipping the whole corpus for a search. CC-07 preloads 500 synthetic rows per register and measures real save/read rendering.

Retain those properties. Also retain the stated meaning of cold: a fresh browser context against a running server with warm OS/SQLite pages is not machine/process cold start. Historical measurements in `docs/acceptance/CC-11/README.md` already say this. These bespoke interaction metrics are not Core Web Vitals or real-device measurements; this review proposes no substitution of arbitrary Lighthouse scores for the accepted budgets.

After AP-01/AP-03, the practical increment is small: record first-usable and complete-table endpoints distinctly where needed; require homogeneous evidence identity; keep expected-result assertions and per-series counts; record browser/host/load/cache conditions; run on one admitted browser slot. Repeat expensive measurements when app/data-path changes or a failure warrants it, not to produce more copies of the same favorable number. No budgets or timings were measured in this review.

## Incoming work and already-closed findings

Two refs were inspected without checkout:

1. **Proofs-final:** `a3f80d1305294a8c685a87351281eef7928c7d9c`, supplied as PR #114. Its diff from pinned dev adds `tests/ci/test-collection.test.ts`, root collection of deployment/identity probe tests, installation of the independently locked identity workspace, and `PROBE_CHECKS`/`PROBE_TESTS` in `scripts/gate-hosted.mjs:62-108`. This closes relevant test-discovery/probe-regression gaps **in incoming source**, not at pinned dev. Reading a committed evidence checker is not executing its real-provider leg. Runtime/Cloudflare findings belong to the other reviewer.
2. **Guard-followups:** `99cf56bba6afc0bf30d0dc914816ad97d1a750ae`. Its merge base with pinned dev is `e44e12b397561e7d7ad229e8fad00753db9f00bc`. Review its introduced work with the merge-base diff: Git-environment isolation, receipt/guard changes and related controls. A raw two-tree diff also shows newer release changes absent from this older branch. Those apparent deletions are **not evidence that the incoming branch intends to remove GRS-173/175**. Merge the updated lower layer and verify the combined result before integration.

GRS-173's unlike-basis interest fix and GRS-175's destructive-action confirmations are **already in pinned dev** (PR #118 integrates release-fixes; current `tests/e2e/quantum/suite.mjs:172-224` and filing/register/litigation/bundle suites contain corresponding assertions). Connector status for both is Done. Do not report the old interest comparison or immediate delete behavior as a new current defect. Preserve their tests during the guard-followups merge.

No PR was created, changed or monitored, and no external service was written. Linear was read only to establish relevant ticket scope/status; current source took precedence over stale historical descriptions.

## Priority handoff

1. **Correct complete-table readiness for metrics/layout (AP-01)** and retain one delayed/late-row synthetic negative control. This is the clearest measurement defect.
2. **Strengthen AC3 action-effect and disabled-action assertions (AP-02)** by reusing the already stronger UI-class approach. Preserve the existing all-store equality round trip.
3. **Make the readiness acceptance boundary explicit (AP-04) and validate metric input identity (AP-03).** A routine gate result must not be presented as fresh release-readiness evidence for checks it omits.
4. **Finish the already tracked GRS-24 production-browser and performance residual**, then the existing hosted viewer/first-workflow owners. Reuse one generation-parameterized journey and a small cross-browser/accessibility task set. Keep planned support, component evaluation, local doubles and production acceptance distinct.

All implementation, validation runs, ticket changes and synthesis are handed to the parent. Report path: `docs/reviews/retrospective-2026-10-22/acceptance-and-performance.md`.
