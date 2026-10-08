# v5 fixture baseline

The frozen reference for GRS-9 (CC-01). It is reproduced by `python3 scripts/fixtures/inventory.py --verify` (setup in [tests/fixtures/README.md](../../tests/fixtures/README.md)); the full machine-readable counts are in [v5-summary.json](v5-summary.json), which `--verify` regenerates and compares byte for byte.

## Fingerprints

| Item | Value |
| --- | --- |
| Archive | `CASE_Lawyer_Pack_v5-002.zip`, 3,257,868,481 bytes, 1,753 entries (all files, no directory entries), 3,257,531,147 bytes uncompressed, stored without compression |
| Archive sha256 | `(pinned in scripts/fixtures/profiles/v5-002.json)` |
| Main HTML | root entry `ESS_DCS_Workspace.html`, 4,494,547 bytes, 3,649 lines |
| Main HTML sha256 | `(pinned in scripts/fixtures/profiles/v5-002.json)` |
| Build date (`META.builtAt`) | (pinned in the local fixture profile) |
| Chronology records | **1,689** (`DATA.chronology`; `META.docCount` 1,689) |
| Navigation entries | **42** in 7 groups (`NAV` literal at line 272) |
| Bundles-only variant | second root HTML, 4,355,150 bytes, sha256 `5794156b11ed3a4b903c3bab4aea5ac804016cdac226d168e339a023fafd4f7d`, 1,562 records |
| Expected examples (local) | sha256 `f23fcdfddffe8ec19b5b71b894f362ac006b01bace0668440fb2d84010d7e931`, see [expected-examples.md](expected-examples.md) |

The older manual's 1,562-document count matches the earlier bundles-only build, not the main HTML; it is not used for any count here.

## How the data is read

Nothing from the archive is executed to obtain data. `DATA` (line 175), `META` (176), `window.__SCHED__` (3175) and `window.__CASELINES_IDX__` (3178) are each one line of JSON, parsed strictly (no `NaN`/`Infinity`, no duplicate keys). `NAV`, `STORE_KEYS` (20), `ENF_OPTS` (5), `CBK` (5), `CBPH` (8) and `CBHF` (8) are JavaScript literals in app code, parsed by a strict literal parser that rejects identifiers, calls, templates and trailing code. The app code with the four data lines blanked has the same sha256 in both HTML files (`64599494…`), so the two builds differ only in data.

## Datasets

| Dataset | Kind | Count | Notes |
| --- | --- | --: | --- |
| `DATA.chronology` | array | 1,689 | Original 605 (OD-), Supplementary 481 (SD-), Correspondence 475 (EM-), Pleadings 1 (PN-), Additional 127 (VDM- 125, AD- 2); text status extracted 1,428, none 255, pending 6; 1,416 dated; 1,308 attachment names with no parent link |
| `DATA.people` | array | 42 | |
| `DATA.entities` | array | 22 | |
| `DATA.matter` | object | 5 keys | |
| `DATA.quantum` | object | 11 keys | amount-due, statement and interest series; invoice ledger 307 |
| `DATA.riskMatrix` | array | 6 | |
| `DATA.defenceMatrix` | array | 8 | |
| `DATA.infoRequired` | array | 6 | |
| `DATA.witnesses` | array | 3 | |
| `DATA.buildReport` | object | 3 keys | |
| `DATA.linkSample` | array | 18 | |
| `DATA.timeline` | object | 4 keys | 81 events |
| `DATA.contracts` | object | 2 keys | 22 items |
| `DATA.filings` | object | 3 keys | 13 items, 3 register seed rows |
| `DATA.contradictions` | object | 5 keys | |
| `DATA.lit` | object | 10 keys | prescription 306 rows |
| `DATA.bundles` | object | 14 keys | 14 bundles; `catalogue` (481 entries) is not used by the UI |
| `META` | object | 11 keys | `textNone` 237 and `emails` 469 disagree with derived counts (255 rows with text status none; 629 e-mail rows) |
| `window.__SCHED__` | object | 2 keys | discovery and supplementary schedules |
| `window.__CASELINES_IDX__` | object | 3 keys | page-text index |

Field names and value counts per dataset are in `v5-summary.json` under `fields`.

## Reference-to-path inventory, missing and duplicate reports

The local inventory (`<fixture root>/v5-002/inventory/<source>/inventory.json`) maps every chronology ref to its decoded original path with size and CRC-32, and classifies every link value in every dataset and in app code. Committed counts:

- **Links:** 7,560 link values in 25 dataset fields resolve to an existing original, 2 resolve to folders, **0 are missing**, 0 escape the case folder. Two literal links in app code resolve (one file, one folder). Denormalised `{ref,url}` pairs disagree with the chronology url 0 times.
- **Zip name encoding:** 2 of 1,753 entries store UTF-8 names without the zip UTF-8 flag; a CP437-decoding reader (Python's `zipfile` by default) would report 2 chronology originals, 2 bundle parts and 2 schedule files as missing. The inventory re-decodes those names as UTF-8 and reports the count in the run envelope (`run.json`, `zipNames.utf8WithoutFlag`).
- **Citations:** 3,137 ref-code values outside the chronology; 3,117 resolve. The 20 that do not (17 XD-, 3 AF-) are in `bundles.catalogue`, which the UI does not use. Court-bundle item keys (655 in bundle rows) are a separate namespace: 443 coincide with a chronology ref, 212 do not (unpadded discovery-item numbers such as `OD-10`); they are reported separately and never resolved as citations.
- **Duplicates:** 0 duplicate chronology refs; 0 chronology rows without a ref (reported, never grouped as a duplicate); 0 originals referenced by two refs; 78 groups (162 files) of identical size and CRC-32 at different paths; 4 groups of repeated file names in different folders; 0 case-fold collisions.
- **Names:** 1,285 paths contain spaces, 2 contain non-ASCII characters, all are NFC; 0 unsafe entries (absolute, `..`, symlink, duplicate).
- **Unreferenced files:** 5 archive files that no link points to (2 in the Additional folder and 3 root documents), besides the two HTML files.

## Main HTML and bundles-only variant

The CLI picks the main HTML by its pinned sha256 in `scripts/fixtures/profiles/v5-002.json`; for an archive that holds no pinned file it picks by content, the one candidate whose chronology contains every other candidate's refs and has the most rows. Build dates and file names never decide. If the archive holds the pinned variant without the pinned main, a root HTML cannot be parsed, or no single candidate is complete, the build stops with exit 2 instead of promoting a variant. Against the variant: same app code; built earlier the same day; `docCount` 1,689 against 1,562; the 127 Additional-bundle rows (VDM- 125, AD- 2) are only in the main HTML, common rows keep their order and fields; `META.bundles` gains `Additional`; `DATA.matter` and `DATA.defenceMatrix` (8 against 6 rows) differ; every other dataset, `__SCHED__`, `__CASELINES_IDX__` and every code literal is identical.

## Views

All 42 `NAV` entries have a live `RENDER.<id>`; `discovery_tab` is assigned twice and the later module wins. The reviewed per-view checklist is [view-checklist.md](view-checklist.md): 213 actions and 58 form fields across the 42 views under its written counting rule (8 more actions in the shared shell), with 152 static handler sites and 7 navigation sites (`data-tab`) counted by the CLI. `python3 scripts/fixtures/count_actions.py` recounts the checklist and checks every declared count; the checklist reconciles the total with the round 1 count (252) and the independent oracle (243). 25 `ess_dcs_*` keys occur in the code; 21 are live user-work stores; 5 live stores are missing from the backup set and 4 backup keys are unused.

## Screens

Representative screens were captured on puk with the browser in a new network namespace (`unshare -rn`; the only interface, `lo`, is down), driven over a CDP pipe with no socket, with `Date` frozen to 2026-10-08T09:00:00Z and the timezone overridden to UTC: overview, chronology (default and Correspondence/e-mail filter), timeline (citation), Defence & Rebuttal (citation), documents, interest calculator (simple and compound), deadlines (fixed clock), deadline delete, privilege log after add/delete, court bundle, CaseLines, discovery schedule and backup. The browser made 0 non-file requests. The two interest examples and the deadline-delete example were captured again with their version 2 inputs (`.orchestration/reports/CC-01/r2/screens/`), also with 0 non-file requests. Command: `scripts/fixtures/capture-screens PLAN OUT`. The screens and the plan are private case material and stay in `.orchestration/reports/CC-01/screens/` on puk.

## Performance baseline

`python3 scripts/fixtures/perf.py --runs 7` (each run a fresh `inventory.py --verify` process reading the zip; archive sha256, inventory, summary comparison and all 13 examples) on puk: 12th Gen Intel Core i7-12700, 20 logical CPUs, 15 GiB RAM, NVMe, CachyOS kernel 7.2.2, Python 3.14.7, archive in the page cache.

| Metric | Median | p95 |
| --- | --: | --: |
| Elapsed, seconds | 2.67 | 2.75 |
| Peak RSS, KiB | 87,864 | 88,216 |

The accepted base has no inventory, so there is no base ratio (N/A). Fail rule for later repeats on the same unchanged fixture and machine: median elapsed above 1.25 × 2.67 = 3.34 seconds (`perf.py --baseline-median 2.67`). A cold page cache adds the time to read 3.26 GB once; compare warm with warm.
