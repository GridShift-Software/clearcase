# CC-25 / GRS-24 compatibility gate

**HOLD at `e87d9cfbd4983789f2455e243b044398195e8ad2`.** Independent reviewer: Claude Opus 5.5. The reviewed product code is `wave/maintenance` at `c6296f7a0de2ba3d7c6a832846ff6208436ee633` (GRS-22, PR #72); the reviewed revision adds only this suite (`tests/acceptance/CC-25/`) and one `vitest.config.ts` include line, which the runner's `revision` step checks. The commit that adds this page changes documentation only.

Items 1, 2, 3 and 5 pass. Item 4 holds: unsupported and invalid input never publishes and the published version stays available, but the operator is not shown what the retained residual data contains. Item 6 holds, because the contract approval is the user's and two gaps remain (GRS-149 and the coverage display). The proposed approval text is at the end.

## Commands

From a clean checkout of the reviewed revision, with `.local/v5-verification.json` in place and the newer export extracted under `.local/` with Python's `zipfile` (not `unzip`: two originals have UTF-8 names):

```sh
scripts/agent-tools/receipt --name cc25-gate --base c6296f7a0de2ba3d7c6a832846ff6208436ee633 -- bun run --bun gate
scripts/agent-tools/receipt --name cc25-gate-runner --base c6296f7a0de2ba3d7c6a832846ff6208436ee633 -- \
  bun tests/acceptance/CC-25/run.ts --out .local/cc25/out --newer-case NEWER_CASE_FOLDER --json-case JSON_CASE_FOLDER
```

The runner reads the gate's own v5 summaries (`.local/gate/v5-out/lanes-v5.json`, `.local/gate/parity-out/scorecard.json`) and requires `evidence: true` for HEAD, so it runs after the gate. Its steps, their logs and `summary.json` are in `--out`; it deletes the packages and the data directory it made unless given `--keep`. Real exports are read from the paths given; nothing from them is committed, and every step prints counts, key names, codes and states only.

| Receipt (`.local/agent-receipts/` in the reviewer's worktree) | Result | Exit |
| --- | --- | --- |
| `20261019T134005.198764Z-cc25-gate` | build, check, test (2,527 tests in 145 files, among them this suite's 13) and test:e2e PASS; parity aborted because Chromium was killed (SIGKILL) in `discovery_tab` after 16 views with 0 unregistered, so the step is not evidence; verify:pilot:v5 not reached | 1 |
| `20261019T140751.867136Z-cc25-parity` | the gate's parity step, unchanged, through `browser-lock`: 42 views, 103,113 values compared, 0 unregistered, `evidence: true` for the reviewed revision | 0 |
| `20261019T141131.615955Z-cc25-verify-pilot-v5` | the gate's `verify:pilot:v5` step, unchanged, through `browser-lock`: 18 of 18 lanes and checks, `evidence: true` | 0 |
| `20261019T141215.699035Z-cc25-gate-runner` | `CC-25 PASS 8 steps` | 0 |

An earlier gate run at the same revision (`20261019T133801*-cc25-gate`) stopped at test:e2e because the reviewer wrote a draft of this page into the checkout during the run. The full gate at the head that adds this page is recorded in the coordinator's GRS-24 report.

## Acceptance items

| # | Item | Evidence at the reviewed revision | Status |
| --- | --- | --- | --- |
| 1 | The v5 acceptance (1,689 documents, 42 views), not weakened | runner `gate-v5`: the `verify:pilot:v5` (18 of 18) and strict `parity --all` (42 views, 0 unregistered) summaries are evidence for the reviewed revision (cited, not re-run by the runner); `probe-v5`: the 23-field v5 inventory in `docs/compatibility.md` re-counted from source and package. No test or check changed outside this suite. After the PR #76 review, `gate-v5` also requires each summary's own passing outcome: the scorecard's `result` PASS and `exit` 0, 42 views extracted and compared with none unimplemented, failed or unregistered, `register.strict`; the lanes summary's `ok` true with every lane PASS; a missing field, an abort or another head fails (negative fixtures: `gate-evidence.test.ts`). | PASS |
| 2 | All 2,131 newer rows; every newer dataset; the JSON-style generation against its own counts | `probe-newer` (24 inventory fields): 2,131 rows, documents and verified originals; 27 source datasets, 20 mapped and 7 residual, none unaccounted; the 19-key analysis overlay kept as one residual dataset; the profile becomes 8 storyline and 5 strategy headings. `probe-json` (21 fields): 4,466 rows; 32 source keys, 17 mapped, 14 residual, 1 dropped with `V5_SOURCE_INDEX_DROPPED`; 29 storyline headings. Neither is compared with the other. | PASS (accounted for; presentation is item 4 and GRS-149) |
| 3 | One versioned contract, correct diagnostics, identities, original mappings, safe rendering | `contract`: each written package validates from its directory against its case folder (verdict REPORT, no error); format `clearcase.results-package` 1, envelopes and asset index as specified; every recognized dataset is the registry's key, schema, kind and required flag; the 22 keys all three write, and the 12 v5 and newer share, have one form each. `resultsVersion` recomputes, the stored bytes verify, and a second conversion gives the same bytes. Every source row, in source order, is its register ref; its indexed path is the row's decoded locator, its size the row's size, and its original verified in the case folder. Every diagnostic code is registered at its severity, and every residual dataset carries both a converter diagnostic and `DS_UNKNOWN_SCHEMA`. `render-switch`: the 42 registry views, the import report and 120 document pages per generation, rendered by the app's routes: 489 pages, all 200, no event-handler attribute, no embedding element, no link or resource outside the app, its originals site or a `rel="noopener noreferrer"` external link, and the same script count per route in each generation. After the PR #76 review the contract step fails a file row whose source locator, declared size or verified-original path differs from the index (negative fixtures: `mapping.test.ts`); on the three real exports every row agrees on all three (v5 1,689, newer 2,131, JSON-style 4,466 rows), with no `#fragment` locator and no undeclared size to account for. | PASS (server-rendered markup; see limits) |
| 4 | Unrecognized data retained privately with coverage and repair information; unsupported or invalid input never publishes; published content stays | `synthetic` (`publication.test.ts`, 11 tests): an uninventoried builder version, a version-less newer marker, a missing and a doubled payload are each refused by the click import as a rejected import (`APP_CONVERSION_REFUSED`), the HTML kept byte for byte at `refused-inputs/<sha256>.html` (0600, directory 0700), nothing stored or written to the destination; a package without its register, with the register relabelled opaque, with a required dataset of unknown schema, a duplicate ref, an invalid ref or `formatVersion` 2 is rejected with nothing stored; an optional unknown dataset and a newer export's unknown key and analysis overlay are stored, listed and refused activation without acknowledgement. After every attempt the published version is still active, verifies, and serves its register and originals; after an acknowledged activation, rollback restores it. `render-switch` on the real packages: the import report names every residual dataset (newer 9 of 9, JSON 16 of 16) but shows none of the converter's coverage (0 of 9, 0 of 16), F1. After the fix round (`6761bf8`, below), the same step requires every converter coverage note on the page and observes them: newer 9 of 9, JSON 17 of 17 (its 16 residual datasets plus the `V5_SOURCE_INDEX_DROPPED` note), v5 0 of 0. | PASS after fix round (F1); not independently re-reviewed |
| 5 | Reused refs never attach user work to another original | `synthetic` (`anchors.test.ts`, 2 tests): one case folder, v5, newer and JSON-script versions giving the same refs to other originals; notes written through the store follow the original's fingerprint through preview, activation, rollback and restart, and are ambiguous, missing or unanchored, never attached by ref. `render-switch` on the real exports: a note on each of the 1,212 refs v5 and the newer export share; on the newer version, before and after activation, 497 stay on refs that keep their original, the 715 on refs that name another original re-attach by fingerprint (576 exact, 139 ambiguous) and 0 follow the ref; after rollback all 1,212 are back on their documents. | PASS |
| 6 | Approve the versioned manual results contract after exact-revision evidence | The evidence for items 1, 2, 3 and 5 passes at the reviewed revision; item 4 holds. Approval is the user's; proposed text below. Markdown round trip not required. | HOLD |

**Limits.** The real newer and JSON exports are rendered on the server, by the app's routes in a Vite dev server, not by the production build in a browser; the escaping itself is proven in Chromium by `tests/case-package/render.test.ts` on synthetic payloads, and the real v5 browser path by `verify:pilot:v5`. No original was opened in the originals viewer for the newer or JSON export.

## Inventories (counts only)

| | v5 | newer | JSON-style |
| --- | ---: | ---: | ---: |
| generation | `v5-js` | `v5-js-newer` (`META.version` V1) | `json-script` |
| chronology rows = register documents = verified originals | 1,689 | 2,131 | 4,466 |
| source datasets: mapped / residual / dropped | 20 / 0 / 0 | 20 / 7 / 0 | 17 / 14 / 1 |
| package datasets: recognized / residual | 35 / 0 | 34 / 9 | 22 / 16 |
| package files, bytes | 37, 6,249,551 | 45, 11,424,891 | 40, 14,550,981 |
| originals: direct / with a parent / embedded | 1,689 / 0 / 1,308 | 1,732 / 399 / 1,577 | 4,310 / 156 / 0 |
| matter headings: storyline / strategy | 6 / 5 | 8 / 5 | 29 / 23 |
| risks shown (category, owner, refs) | 6 (0, 0, 0) | 0 (overlay holds 14) | 38 (38, 38, 0) |
| validation verdict, then warnings and infos by code | REPORT | REPORT | REPORT |
| `DS_UNKNOWN_SCHEMA` / `DS_UNSUPPORTED_FIELD` | 0 / 0 | 9 / 100 | 16 / 39 |
| `MEDIA_UNSUPPORTED` / `TEXT_NONE` / `TEXT_PENDING` | 910 / 242 / 417 | 1,164 / 37 / 466 | 14 / 12 / 1 |
| `ASSET_DUPLICATE_CONTENT` / `TEXT_CONTROL_CHARS` / `CITE_BARE_MENTION` | 67 / 30 / 10 | 185 / 78 / 24 | 588 / 151 / 2 |
| other validator codes | `CITE_UNRESOLVED` 20, `V5_META_COUNT_DISAGREEMENT` 2 | `DS_DATE_INVALID` 3 | `ORIG_MEDIA_MISMATCH` 4, `DS_ENUM_UNKNOWN` 1 |

Conversion and validation baselines, one run each on this host, not comparable across corpora: convert 1,913, 2,447 and 3,548 ms; validate 1,899, 2,372 and 3,566 ms; probe peak RSS 291, 394 and 644 MiB (v5, newer, JSON-style). Server rendering in the dev server, per generation (163 pages): 3,566, 2,505 and 4,088 ms. No new budget is set; overview, navigation and search latency on the newer and JSON exports remain unmeasured against the v5 budgets.

## Findings

- **F1 (medium, item 4).** `src/routes/import/[id]/+page.server.ts:14-22` reads only `V5_TEXT_CAPPED` from the stored conversion report. The converter's coverage of data it kept but does not present (`V5_OVERLAY_UNMAPPED`, which names the newer analysis overlay's 19 keys and their counts, `V5_UNMAPPED_KEY` and `V5_DATASET_SHAPE_UNMAPPED`) is retained in the package and never shown. The operator sees one generic `DS_UNKNOWN_SCHEMA` line per residual dataset ("opaque dataset: preserved, not rendered"; "Review the dataset; it is kept but not shown"). On the real newer export, the report does not say that the 14 risks, 93 timeline events, the matter, 11 defence rows and 10 witnesses exist; its Risk Matrix says there is no risk matrix. GRS-22 recorded this as a follow-up.
- **F2 (low).** No package records which generation produced it. `inputRevision.kind` is `v5-workspace-html` for all three, and the conversion report has no generation field, so a stored version cannot show that it came from a newer or JSON-style export, nor which builder version.

## Fix round (F1 and F2, added by the GRS-24 fix worker)

Product code `6761bf8d4afb`; the gate (`build`, `check`, `test`, `test:e2e`, `parity`, `verify:pilot:v5`) passed at that head (receipt `fix24-gate`), and this suite passed 8 of 8 steps at it with `--base 6761bf8`. This page is not an independent re-review.

- **F1 fixed.** The import report has a "Source coverage" section (`#source-coverage`) listing every note the conversion report holds other than the text cap, grouped by code, each with its subject, the converter's own message and counts, and the code's hint; nothing shown when there are none, "not known" when the package has no conversion report. No code list is involved: a note the converter gains later shows up.
- **F2 fixed in the conversion report only.** It gains an optional `source` object, `{ generation, builderVersion? }`, written for `v5-js-newer` (real newer export: `V1`) and `json-script` (no version stated); v5 adds nothing, so v5 package bytes and the pinned fixture identity are unchanged. `inputRevision.kind` stays `v5-workspace-html` for all three (a manifest schema change was out of scope).

## Fix round 2 (PR #76 external review, PRFIX-76)

Findings 2 and 3 of the review concerned this suite: `gate-v5` accepted a scorecard with `result` FAIL or no outcome (it read `ok`, which the scorecard does not write), and the contract step tallied `pathOther`, `sizeDiffers` and `realPathDiffers` without failing on them. Both now fail as described in items 1 and 3; the checks are `gate-evidence.ts` and `mapping.ts`, with negative fixtures beside them. The render step now also fails when a residual dataset is not named on the import report (it was counted and never judged), and the revision step fails when `git diff` against `--base` fails (an unknown base read as "no product file changed"). The runner's `--base` for this round is the last product commit, `1d9948144e207943462c2277eb611462ed96095c`: the round changes `src/` (import lock, source coverage), so the default base no longer applies. Evidence is in the PRFIX-76 report.

## What remains HOLD

- GRS-149: map the newer analysis overlay into the views (risks, matter, timeline, defence, witnesses and the other 14 keys); until then the newer export's analysis is retained, listed by name and not presented.
- F1: fixed in the fix round above, pending the gate's re-verification.
- The Markdown round trip (GRS-23) is deferred and not required for alpha.
- A browser run of the production build on the real newer and JSON exports, and their latency against the v5 budgets.
- GRS-22's open lows: L1 (text-cap count by entry, not document), L4 and L5 (newer risk `source_*` collision; marker typing).

## Proposed approval text (conditional)

> Approved as the versioned manual results contract for alpha: results package `formatVersion` 1 (`clearcase.results-package`, dataset envelope `clearcase.dataset/1`, asset index `clearcase.assets/1`), as written by `clearcase-v5-adapter@0` at `c6296f7a0de2ba3d7c6a832846ff6208436ee633` from the `v5-js`, `v5-js-newer` (`META.version` V1 only) and `json-script` workspace generations, and uploaded as a structured package with an editable private preview. Data a generation carries that no view reads is retained privately as residual datasets and is not presented; the newer export's hand-authored analysis is unsupported until GRS-149. A Markdown round trip is not part of this contract.

The text applies only once items 4 and 6 pass: F1 fixed or accepted by the user as a known limit, and GRS-149 either done or accepted as the newer export's known gap. Until then this gate stays HOLD.
