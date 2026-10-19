# Export compatibility (GRS-22, CC-12)

Three generations of the case builder's workspace HTML convert through the one results-package contract ([results-package.md](results-package.md#the-v5-adapter)). The converter detects each one explicitly and refuses anything else. This page records what each observed export holds, counted from the source on 19 October 2026, and where each part ends up. `tests/case-package/compat/probe.ts` converts and validates a real export under `.local/`, counts its inventory again and fails when it differs from the block below; its receipts are the evidence. Only counts, dataset names and shapes are recorded here.

## Generations

| Generation | Detected by | Observed export |
| --- | --- | --- |
| `v5-js` | the four payload lines (`const DATA`, `const META`, `window.__SCHED__`, `window.__CASELINES_IDX__`) and no newer marker | the v5 sample, 1,689 documents (`CASE_Lawyer_Pack_v5-002.zip`) |
| `v5-js-newer` | the same lines with `META.version` `V1` (the builder also writes `META.fileCount` and `DATA.profile`) | the newer export, 2,131 documents (`CASE_Lawyer_Pack-001.zip`) |
| `json-script` | `<script id="app-data" type="application/json">` and `app-seed`, no payload lines | the Sample Matter data room, 4,466 documents, the only JSON-style export on this host |

`CASE_Lawyer_Pack-003.zip` is byte-identical to `-001` (same size and sha256), so it is the newer generation again, not a JSON export.

Anything else is refused, and conversion writes nothing:

- a `META.version` other than `V1`, whatever its type, is `VER_UNSUPPORTED` (error), because nobody has inventoried that builder;
- an HTML without the payload lines and without `app-data` is `V5_PAYLOAD_MISSING`;
- one with both is `V5_PAYLOAD_AMBIGUOUS`.

The received HTML and case folder are left as they were.

## Source inventory

| | v5 | newer | JSON script |
| --- | ---: | ---: | ---: |
| chronology rows | 1,689 | 2,131 | 4,466 |
| top-level datasets | 17 `DATA` keys, `META`, 2 auxiliary roots | 24 `DATA` keys, `META`, 2 auxiliary roots | 21 `app-data` keys, 11 `app-seed` keys |
| bundle groups (`META.bundles`) and court bundles | 5 and 14 | 8 and 14 | 4 and 4 |
| row position type (`n`, `seq`) | text | number | number |
| rows with their own original and a parent (`pr`) | 0 | 399 | 156 |
| embedded attachments (names inside a parent) | 1,308 | 1,577 | 0 |
| verdict of the full validation | REPORT | REPORT | REPORT |

```json compat-inventory
{
 "v5": {"generation": "v5-js", "chronologyRows": 1689, "dataKeys": 17, "auxiliaryRoots": 2, "metaVersion": null, "bundleGroups": 5, "courtBundles": 14, "storylineEntries": 6, "profileKeys": 0, "risks": 6, "textEntries": 0, "textAtCap": 0, "rowsWithoutText": null, "rowsWithParent": 0, "positionTypes": {"string": 1689}, "emails": null, "verdict": "report", "documents": 1689, "unaccounted": [], "demoted": [], "analysisOverlay": null, "riskFields": {"risks": 6, "category": 0, "owner": 0, "refs": 0}, "textCapNotice": null},
 "ess-newer": {"generation": "v5-js-newer", "chronologyRows": 2131, "dataKeys": 24, "auxiliaryRoots": 2, "metaVersion": "V1", "bundleGroups": 8, "courtBundles": 14, "storylineEntries": 0, "profileKeys": 30, "risks": 0, "textEntries": 2049, "textAtCap": 576, "rowsWithoutText": 82, "rowsWithParent": 399, "positionTypes": {"number": 2131}, "emails": {"rows": 568, "threads": 198, "gaps": 29}, "verdict": "report", "documents": 2131, "unaccounted": [], "demoted": ["lit-presc-summary"], "refReuse": {"sharedRefs": 1212, "sameOriginal": 497, "changedOriginal": 715, "anchorOutcome": {"ambiguous": 139, "exact": 576}, "followedTheRef": 0}, "analysisOverlay": {"matter": 7, "timeline": 2, "riskMatrix": 14, "legality": 4, "defenceMatrix": 11, "elements": 9, "recon": 57, "settlement": 8, "enforcement": 7, "organogram": 2, "witnesses": 10, "anchors": 32, "contradictions": 5, "authorities": 19, "crossexam_seed": 7, "infoRequired": 14, "prescription": 46, "prescSummary": 5, "interestBasis": 9}, "riskFields": {"risks": 0, "category": 0, "owner": 0, "refs": 0}, "textCapNotice": "576 of 2,049 document texts (DATA.text) stop at the 4,000-character cap, so the export holds only their first 4,000 characters"},
 "sample-matter-json": {"generation": "json-script", "chronologyRows": 4466, "appDataKeys": 21, "appSeedKeys": 11, "bundleGroups": 4, "courtBundles": 4, "matters": 3, "storylineEntries": 26, "risks": 38, "risksWithOwner": 38, "risksWithType": 38, "rowsShortened": 741, "rowsWithDateSource": 4465, "rowsWithParent": 156, "positionTypes": {"number": 4466}, "verdict": "report", "documents": 4466, "unaccounted": [], "demoted": [], "riskFields": {"risks": 38, "category": 38, "owner": 38, "refs": 0}, "textCapNotice": "741 of 4,466 chronology rows are marked shortened (sh) by the export, which holds only part of their text"}
}
```

The probe runs as `bun tests/case-package/compat/probe.ts --html FILE --case-folder DIR --case-id ID --expect NAME`. Give the `ess-newer` run `--compare-with` the v5 package, which the `v5` run writes with `--out DIR`.

## Where every top-level dataset goes

Each source key becomes a recognized dataset, an opaque residual dataset (`opaque@1`, with the warning `V5_UNMAPPED_KEY`, retained but not presented), or, for exactly one key, nothing, with a diagnostic that says so. A residual dataset has no view, so it is **unsupported**, not a completed feature. No key goes unaccounted in any of the three exports.

**v5.** All 17 `DATA` keys, `META` and both auxiliary roots map to recognized v5 datasets. Nothing is residual.

**Newer.** 20 of the 27 source datasets map: the 17 v5 keys, `META`, `window.__SCHED__` (now a list of three schedules, kept whole under `schedules`) and `window.__CASELINES_IDX__` (a page-to-text map, read as the CaseLines index). `lit.prescSummary` is an empty object, so it is demoted to `v5-residual-lit-presc-summary` (`V5_DATASET_SHAPE_UNMAPPED`) and the Prescription summary shows its empty state. The seven new datasets:

| Dataset | Rows | Presentation |
| --- | ---: | --- |
| `profile` | 30 fields | Matter & Strategy: the adapter writes the narrative fields as 8 storyline and 5 strategy headings, because `DATA.matter` is an empty object (the newer viewer fills it from its hand-authored analysis instead, below). The whole profile is also kept as `v5-residual-profile`. |
| `text` | 2,049 entries | unsupported: no view. 576 entries (28%) stop at exactly 4,000 characters (the builder's cap) and 82 rows have no entry; the validation report shows the count (`V5_TEXT_CAPPED`). The chronology excerpt is 400 characters. |
| `emails` | 568 rows, 198 threads, 29 gaps | unsupported: no Emails or Email silences view (BA-11) |
| `transcripts` | 1 | unsupported: no view |
| `anchors`, `organogram`, `whatsapp` | 0 | empty in this export, and unsupported |

**JSON script.** 17 keys map, among them the chronology, people, entities, contradictions, agreements (as contracts), bundles, the client and matters (as the storyline), risk, defence, info required, witnesses, elements, authorities and the discovery schedule. `hot` builds the timeline and is also kept residual, and `meta` is kept residual beside the `META` the adapter derives from the rows. `ft`, the viewer's own token index, is the one key dropped, with `V5_SOURCE_INDEX_DROPPED` (info). Fourteen keys are residual and unsupported: `fulltext`, `pages`, `threads`, `taxevents`, `vdp`, `dcand`, `firms`, `sections`, `tax`, `taxsum`, `valuations`, `financials`, the seed's `settlement` and `conflict_note`. A record field the v5 shape has no place for stays on its record and is reported as `DS_UNSUPPORTED_FIELD`. On chronology rows that includes the text length `tl` and the shortened flag `sh`: 741 of 4,466 rows are marked shortened, and the validation report shows that count (`V5_TEXT_CAPPED`). A risk's `type` is renamed `category`, the newer builder's name for it.

## The newer viewer's hand-authored analysis

The newer HTML carries a second payload that is code, not a payload line: the module `mod_00_analysis.js` opens with `(function(){ const X = {…};` and merges `X` into `DATA` at run time (`Object.assign` or `push` into `DATA.matter`, `DATA.timeline`, `DATA.riskMatrix` and 16 more). In this export the matching `DATA` slots are empty, so everything the newer viewer shows on those pages comes from `X`. The converter reads only the payload lines and does not read `X`, so ClearCase shows none of it, and no diagnostic says so. The probe counts it as `analysisOverlay`: 19 keys, among them `matter` (6 storyline and 6 strategy headings), 93 timeline events, 14 risks (each with `category`, `owner` and `refs`), 11 defence rows, 10 witnesses, 14 info-required items, 32 anchors, 19 authorities and 46 prescription rows.

Reading `X` means parsing that one literal with the strict parser (never evaluating it) and applying the module's fixed list of merges for builder `V1`. It changes what steps 3, 4 and 5 found for the newer export, so it is a follow-up, not part of this page's verdicts.

## Verification steps

The PASS and FAIL verdicts are at the head named in the GRS-22 report.

| Step | Evidence | Verdict |
| --- | --- | --- |
| 1. The v5 pilot, unchanged | the gate's `verify:pilot:v5`; `json-workspace.test.ts` pins the v5 fixture package byte for byte; the `v5` probe | PASS |
| 2. Exactly 2,131 newer rows | the `ess-newer` probe (2,131 source rows, 2,131 documents, 2,131 originals verified); `compat.test.ts` "row positions as the source wrote them" | PASS |
| 3. Every top-level dataset | `compat.test.ts` "every top-level source dataset is accounted for"; the three probes (`unaccounted` empty) | PASS for the payload lines; residual datasets are retained, not presented. The newer viewer's hand-authored analysis is not read (above). |
| 4. The changed storyline shape | `compat.test.ts` "the storyline shapes of each generation"; `matterOf` in `newer-workspace.test.ts` and `json-workspace.test.ts`; the probes (newer: profile to 8 and 5 headings; JSON: 26 pairs to 29 headings) | PASS |
| 5. Risks with category, owner and refs | `compat-views.test.ts` "step 5" (the page shows Category, Owner and Documents only when a risk carries them, links only refs in the register, and keeps v5's four columns); `compat.test.ts` "risks with category, owner and refs"; the probes' `riskFields` (JSON script: 38 risks, all with category and owner, none with refs; v5: 6 risks, none) | PASS for the JSON script and v5. The newer export's 14 risks are in its hand-authored analysis, which the converter does not read, so it shows none. |
| 6. An indexed attachment or its parent route | `src/lib/local-case/ssr-pages.test.ts` "SSR pages: import-time and parent-original states"; the v5 lane `routes`; the probes (newer: 399 attachments with their own original and a parent, 1,577 embedded; all verified at import) | PASS on synthetic pages; no real-data browser run |
| 7. Text truncation coverage on screen | `compat-views.test.ts` "step 7": the validation report (`/import/[id]`) shows a Source text coverage section from the conversion's `V5_TEXT_CAPPED` diagnostics, nothing when there are none, and says the coverage is unknown when a package has no conversion report; `compat.test.ts` "text cut short by the source export"; the probes' `textCapNotice` (newer 576 of 2,049; JSON 741 of 4,466; v5 none) | PASS on synthetic pages; no real-data browser run |
| 8. A reused ref with another original | `compat.test.ts` "a ref reused for another original across generations"; `src/lib/local-case/user-work.test.ts` "a reused ref does not carry them"; the `ess-newer` probe against the v5 package (715 of 1,212 shared refs name another original; their v5 anchors re-attach by fingerprint, 576 exactly and 139 ambiguous, and none follows the ref) | PASS |
| 9. Refuse unrecognized formats | `compat.test.ts` "generation detection" | PASS for the converter: nothing is converted or written, and the input is untouched. The click import shows the refusal but keeps no record of it. |
| 10. Switch versions, user work scoped | `src/lib/local-case/user-work.test.ts` (notes survive activating a renumbered version and a restart); `service.test.ts` "rollback checks the expected active version and target"; `contracts-m2.test.ts` "R2-2" (a case table keeps other cases' rows) | PASS on synthetic cases; no real-data run |

## Business-audit rechecks on the newer export

| Item | Newer export | State |
| --- | --- | --- |
| BA-04 date basis | 2,012 of 2,131 rows are dated and no row has a date type or source, so the Date basis column says "basis unknown" for each (`dateBasis` in `format.ts`); 3 dates are not calendar dates (`DS_DATE_INVALID`). The JSON script gives 4,465 rows a date source, which the column shows. | explicit |
| BA-05 classification | `doc_type`, contract groups and filing groups are imported classifications; Documents, Contracts and Filings carry the unconditional "not verified" disclosure | explicit |
| BA-07 identity | 111 of 122 people have a role (v5 had none); People shows the column as "Role (inferred, unverified)" under the identity disclosure; there are no privilege suggestions | explicit |
| BA-09 direct or parent original | 1,732 direct originals, 399 attachments with their own original and a parent, 1,577 embedded attachments reached through their parent (`OriginalOpen`: direct, parent route, unavailable) | explicit |
| BA-11 e-mail subset | `emails` (568 rows, 198 threads, 29 gaps) is residual with `V5_UNMAPPED_KEY`; no Emails or Email silences view | unsupported |

Full metadata re-extraction and expanded OCR stay deferred.

## Conversion baseline

These are single runs of the probe on puk at the GRS-22 head, converting and fully validating from the extracted case folder. They describe each export on its own: the corpora differ in size, so the figures are not a speedup or a slowdown against each other.

| | v5 | newer | JSON script |
| --- | ---: | ---: | ---: |
| convert, ms | 2,360 | 2,609 | 4,196 |
| validate, ms | 1,953 | 2,458 | 3,849 |
| peak RSS of the probe, MiB | 267 | 398 | 670 |

Overview, navigation and search latency on the newer export were not measured.
