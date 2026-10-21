# Export compatibility (GRS-22, CC-12)

Three generations of the case builder's workspace HTML convert through the one results-package contract ([results-package.md](results-package.md#the-v5-adapter)). The converter detects each one explicitly and refuses anything else. This page records what each observed export holds, counted from the source on 19 October 2026, and where each part ends up. `tests/case-package/compat/probe.ts` converts and validates a real export under `.local/`, counts its inventory again and fails when it differs from the block below; its receipts are the evidence. Only counts, dataset names and shapes are recorded here.

## Generations

| Generation | Detected by | Observed export |
| --- | --- | --- |
| `v5-js` | the four payload lines (`const DATA`, `const META`, `window.__SCHED__`, `window.__CASELINES_IDX__`) and no newer marker | the v5 sample, 1,689 documents (`CASE_Lawyer_Pack_v5-002.zip`) |
| `v5-js-newer` | the same lines with `META.version` `V1` (the builder also writes `META.fileCount` and `DATA.profile`) | the newer export, 2,131 documents (`CASE_Lawyer_Pack-001.zip`) |
| `json-script` | `<script id="app-data" type="application/json">` and `app-seed`, no payload lines | the JSON-style data room, 4,466 documents, the only JSON-style export on this host |

`CASE_Lawyer_Pack-003.zip` is byte-identical to `-001` (same size and sha256), so it is the newer generation again, not a JSON export.

Anything else is refused, and conversion writes nothing:

- a `META.version` other than `V1`, whatever its type, is `VER_UNSUPPORTED` (error), because nobody has inventoried that builder; so is a newer marker (`META.fileCount` or `DATA.profile`) with no `META.version` at all;
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
 "ess-newer": {"generation": "v5-js-newer", "chronologyRows": 2131, "dataKeys": 24, "auxiliaryRoots": 2, "metaVersion": "V1", "bundleGroups": 8, "courtBundles": 14, "storylineEntries": 0, "profileKeys": 30, "risks": 0, "textEntries": 2049, "textAtCap": 576, "rowsWithoutText": 82, "rowsWithParent": 399, "positionTypes": {"number": 2131}, "emails": {"rows": 568, "threads": 198, "gaps": 29}, "verdict": "report", "documents": 2131, "unaccounted": [], "demoted": ["timeline-phases"], "refReuse": {"sharedRefs": 1212, "sameOriginal": 497, "changedOriginal": 715, "anchorOutcome": {"ambiguous": 139, "exact": 576}, "followedTheRef": 0}, "analysisOverlay": {"anchors": 32, "authorities": 19, "contradictions": 5, "crossexam_seed": 7, "defenceMatrix": 11, "elements": 9, "enforcement": 7, "infoRequired": 14, "interestBasis": 9, "legality": 4, "matter": 7, "organogram": 2, "prescSummary": 5, "prescription": 46, "recon": 57, "riskMatrix": 14, "settlement": 8, "timeline": 2, "witnesses": 10}, "riskFields": {"risks": 14, "category": 14, "owner": 14, "refs": 14}, "analysisRead": {"anchors": {"v5-residual-anchors": 32}, "authorities": {"lit-authorities": 19}, "contradictions": {"contradictions": 6}, "crossexam_seed": {"lit-crossexam-seed": 7}, "defenceMatrix": {"defence-matrix": 11}, "elements": {"lit-elements": 9}, "enforcement": {"lit-enforcement": 7}, "infoRequired": {"info-required": 14}, "interestBasis": {"lit-interest-basis": 13}, "legality": {"lit-legality": 4}, "matter": {"matter": 7}, "organogram": {"v5-residual-organogram": 2}, "prescSummary": {"lit-presc-summary": 5}, "prescription": {"lit-prescription": 46}, "recon": {"lit-recon": 57}, "riskMatrix": {"risk-matrix": 14}, "settlement": {"lit-settlement": 9}, "timeline": {"timeline-events": 93, "v5-residual-timeline-phases": 6}, "witnesses": {"witnesses": 10}}, "textCapNotice": "576 of 2,049 document texts (DATA.text) stop at the 4,000-character cap, so the export holds only their first 4,000 characters"},
 "json-room": {"generation": "json-script", "chronologyRows": 4466, "appDataKeys": 21, "appSeedKeys": 11, "bundleGroups": 4, "courtBundles": 4, "matters": 3, "storylineEntries": 26, "risks": 38, "risksWithOwner": 38, "risksWithType": 38, "rowsShortened": 741, "rowsWithDateSource": 4465, "rowsWithParent": 156, "positionTypes": {"number": 4466}, "verdict": "report", "documents": 4466, "unaccounted": [], "demoted": [], "riskFields": {"risks": 38, "category": 38, "owner": 38, "refs": 0}, "textCapNotice": "741 of 4,466 chronology rows are marked shortened (sh) by the export, which holds only part of their text"}
}
```

The probe runs as `bun tests/case-package/compat/probe.ts --html FILE --case-folder DIR --case-id ID --expect NAME`. Give the `ess-newer` run `--compare-with` the v5 package, which the `v5` run writes with `--out DIR`. For the newer export, `analysisOverlay` counts the roots of its analysis module as the source holds them, and `analysisRead` names, for each root, the package datasets it reached and their counts (below).

## Where every top-level dataset goes

Each source key becomes a recognized dataset, an opaque residual dataset (`opaque@1`, with the warning `V5_UNMAPPED_KEY`, retained but not presented), or, for exactly one key, nothing, with a diagnostic that says so. A residual dataset has no view, so it is **unsupported**, not a completed feature. No key goes unaccounted in any of the three exports.

**v5.** All 17 `DATA` keys, `META` and both auxiliary roots map to recognized v5 datasets. Nothing is residual.

**Newer.** 20 of the 27 source datasets map: the 17 v5 keys, `META`, `window.__SCHED__` (now a list of three schedules, kept whole under `schedules`) and `window.__CASELINES_IDX__` (a page-to-text map, read as the CaseLines index). The analysis slots of `DATA` are empty in the payload line and filled by the analysis module (below), as the newer viewer fills them at run time. The seven new datasets:

| Dataset | Rows | Presentation |
| --- | ---: | --- |
| `profile` | 30 fields | kept whole as `v5-residual-profile`. Its narrative fields stand in for the matter only when `DATA.matter` is still empty after the analysis module (8 storyline and 5 strategy headings before GRS-149); in this export the module's matter fills it. |
| `text` | 2,049 entries | unsupported: no view. 576 entries (28%) stop at exactly 4,000 characters (the builder's cap) and 82 rows have no entry; the validation report shows the count (`V5_TEXT_CAPPED`). The chronology excerpt is 400 characters. |
| `emails` | 568 rows, 198 threads, 29 gaps | unsupported: no Emails or Email silences view (BA-11) |
| `transcripts` | 1 | unsupported: no view |
| `anchors`, `organogram` | 32; 25 nodes and 20 edges | empty in the payload line and filled by the analysis module; residual (`V5_UNMAPPED_KEY` with the count), no view reads them |
| `whatsapp` | 0 | empty in this export, and unsupported |

**JSON script.** 17 keys map, among them the chronology, people, entities, contradictions, agreements (as contracts), bundles, the client and matters (as the storyline), risk, defence, info required, witnesses, elements, authorities and the discovery schedule. `hot` builds the timeline and is also kept residual, and `meta` is kept residual beside the `META` the adapter derives from the rows. `ft`, the viewer's own token index, is the one key dropped, with `V5_SOURCE_INDEX_DROPPED` (info). Fourteen keys are residual and unsupported: `fulltext`, `pages`, `threads`, `taxevents`, `vdp`, `dcand`, `firms`, `sections`, `tax`, `taxsum`, `valuations`, `financials`, the seed's `settlement` and `conflict_note`. A record field the v5 shape has no place for stays on its record and is reported as `DS_UNSUPPORTED_FIELD`. On chronology rows that includes the text length `tl` and the shortened flag `sh`: 741 of 4,466 rows are marked shortened, and the validation report shows that count (`V5_TEXT_CAPPED`). A risk's `type` is renamed `category`, the newer builder's name for it.

## The newer viewer's hand-authored analysis

The newer HTML carries its analysis as code, not as a payload line. The module `mod_00_analysis.js` opens with `(function(){ const X = {…};` and, on the next line, merges the 19 roots of `X` into `DATA` with 19 statements (`Object.assign` onto an object, `push.apply` onto a list, and, for the timeline, `Object.assign` of its `phases` and `events` only), then closes with `})();`. In this export the matching `DATA` slots are empty, so everything the newer viewer shows on those pages comes from `X`.

The converter reads it without running it (`src/lib/case-package/v5/analysis-overlay.ts`). It finds the one line-anchored literal inside the module and parses it with the strict parser. It reads the statements between the literal and `})();` as text and recognises only the 19 merges of builder `V1`, pinned in `V1_MERGES` with the exact text the builder writes. It then places each root into `DATA` in the builder's order, before the newer mapping and the dataset loop. A merge applies only when `X` holds its root and the `DATA` slot is the kind the statement needs. The reader fails closed: every non-empty statement between the literal and `})();` must be one of the 19 merges, and each may appear once. An unrecognised statement (an assignment, a comment, a string) or a repeated merge applies no merge at all, so `X` stays whole in the residual dataset, and the warning counts the unrecognised and the repeated statements. The converter is more lenient than the viewer in one respect: a push onto a slot that is not a list (an object, an absent slot) throws in the viewer, so none of the merges after it would run there, while an assign onto an array, string or number does not throw and the later merges run. In every such case the converter leaves that root residual and still places the later ones. Whatever no merge places stays in the opaque dataset `v5-residual-analysis-overlay`, and the warning `V5_OVERLAY_UNMAPPED` names its keys and their counts. A module with no such literal, with more than one, or whose literal is not strict JSON gives `V5_OVERLAY_UNREADABLE`, and nothing is imported from it; an export without the module gives neither. The newer mapping (`newer-workspace.ts`) then rewrites the records written in the newer viewer's shapes into the v5 shapes and keeps every field it does not read on its record (`DS_UNSUPPORTED_FIELD`). A record already in the v5 shape stays as written.

**Size notes.** The adapter appends a size to the `V5_UNMAPPED_KEY` message of every residual key (for example `DATA.zzextra (3 entries)`). The conversion report is a file of the package, so this changes the package bytes and the `resultsVersion` of every JSON-script conversion that has a residual key, and of every newer one. A v5 export has no residual key, so its package bytes are unchanged and the byte pin still holds.

Counted from the source on 21 October 2026 (`analysisOverlay` and `analysisRead` in the inventory above):

| Root of `X` | In the module | Package dataset | What the mapping does |
| --- | ---: | --- | --- |
| `matter` | title, 6 storyline and 6 strategy headings | `matter` | `[heading, text]` pairs become `{h, t}`; `summary` and `status` carried. The profile no longer stands in. |
| `timeline.events` | 93 | `timeline-events` | `type` is `kind`, `detail` is `note`, the first of `refs` is `ref` with that row's `url`; `phase` and `refs` carried |
| `timeline.phases` | 6 | residual `v5-residual-timeline-phases` (`V5_DATASET_SHAPE_UNMAPPED`) | each phase is bounded by dates and names its events by key; v5 phases are year ranges that place events by year, which would show 57 of the 93 events in two phases, so the phases stay residual and the Timeline lists the events outside phases |
| `riskMatrix` | 14 | `risk-matrix` | every risk with `category`, `owner` and `refs` |
| `defenceMatrix` | 11 | `defence-matrix` | `theirs` is `dcs`; each cited ref becomes a document link (`docs`); `refs` is empty |
| `witnesses` | 10 | `witnesses` | as written; `side`, `proves`, `docs`, `status` carried |
| `infoRequired` | 14 | `info-required` | as written; `id`, `why`, `refs`, `from` carried |
| `contradictions` | 5 categories, 19 items, 6 checks | `contradictions` | an item's refs become document links, `values` carried; the checks carry no count `n`, so they are kept as `source_checks` and the view lists no checks |
| `legality` | intro, 14 documents, 4 scenarios, 5 factors | `lit-legality` | as written |
| `elements` | 9 | `lit-elements` | `goto` is `tab`; `refs`, `gap` carried |
| `recon` | 57 | `lit-recon` | `period` is `month`, `due` is `amountdue`; `breakdown` carried |
| `settlement` | 8 fields | `lit-settlement` | `claim` as written, `claimDate` from the quantum headline; the rest carried |
| `enforcement` | 7 | `lit-enforcement` | as written |
| `authorities` | 19 | `lit-authorities` | as written |
| `crossexam_seed` | 7 | `lit-crossexam-seed` | the list of cited refs becomes one line of text |
| `prescription` | 46 | `lit-prescription` | as written; `due`, `amount` carried |
| `prescSummary` | 5 fields | `lit-presc-summary` | as written, `keyEvent` carried; no longer demoted |
| `interestBasis` | 9 fields | `lit-interest-basis` | merged onto the builder's own 4 fields; the headline date and first invoice date as before |
| `anchors` | 32 | residual `v5-residual-anchors` (`V5_UNMAPPED_KEY`) | no view |
| `organogram` | 25 nodes, 20 edges | residual `v5-residual-organogram` (`V5_UNMAPPED_KEY`) | no view |

Every root reaches the package: 16 roots and the timeline events fill the datasets v5 and the JSON script fill, and the timeline phases, the anchors and the organogram stay residual with a diagnostic: `V5_UNMAPPED_KEY` gives the anchors' and the organogram's counts, and `V5_DATASET_SHAPE_UNMAPPED` names the phases without a count (their dataset holds 6). No root is left in `v5-residual-analysis-overlay` for this export. The validation of the newer package reports 8 residual datasets (`DS_UNKNOWN_SCHEMA`), 131 unsupported fields (`DS_UNSUPPORTED_FIELD`) and 176 bare ref mentions (`CITE_BARE_MENTION`; the module cites refs as plain text).

## Verification steps

The verdicts of steps 1, 2 and 5 to 10 are at the head named in the GRS-22 report. The verdicts of steps 3 and 4, where they cite the analysis module, are at GRS-149's product head, the one named on the CC-25 page with its runner receipt.

| Step | Evidence | Verdict |
| --- | --- | --- |
| 1. The v5 pilot, unchanged | the gate's `verify:pilot:v5`; `json-workspace.test.ts` pins the v5 fixture package byte for byte; the `v5` probe | PASS |
| 2. Exactly 2,131 newer rows | the `ess-newer` probe (2,131 source rows, 2,131 documents, 2,131 originals verified); `compat.test.ts` "row positions as the source wrote them" | PASS |
| 3. Every top-level dataset | `compat.test.ts` "every top-level source dataset is accounted for"; the three probes (`unaccounted` empty); for the newer analysis module, `newer-analysis.test.ts` and the `ess-newer` probe's `analysisRead` | PASS; residual datasets are retained, not presented. Each of the module's 19 roots reaches a recognized dataset, or stays residual with a diagnostic and its count (timeline phases, anchors, organogram; above) (GRS-149). |
| 4. The changed storyline shape | `compat.test.ts` "the storyline shapes of each generation"; `matterOf` in `newer-workspace.test.ts` and `json-workspace.test.ts`; `newer-analysis.test.ts` and `newer-analysis-views.test.ts` (the module's pairs); the probes (newer: the module's 6 and 6 headings; JSON: 26 pairs to 29 headings) | PASS |
| 5. Risks with category, owner and refs | `compat-views.test.ts` "step 5" (the page shows Category, Owner and Documents only when a risk carries them, links only refs in the register, and keeps v5's four columns); `compat.test.ts` "risks with category, owner and refs"; the probes' `riskFields` (JSON script: 38 risks, all with category and owner, none with refs; v5: 6 risks, none) | PASS for all three: the newer export's 14 risks come from its analysis module, each with category, owner and refs (`riskFields`; `newer-analysis-views.test.ts` renders them). A risk field of the wrong type (a null owner, a text `refs`) is kept as `source_<name>` and never demotes the matrix, in either generation (`read-lists.test.ts`). |
| 6. An indexed attachment or its parent route | `src/lib/local-case/ssr-pages.test.ts` "SSR pages: import-time and parent-original states"; the v5 lane `routes`; the probes (newer: 399 attachments with their own original and a parent, 1,577 embedded; all verified at import) | PASS on synthetic pages; no real-data browser run |
| 7. Text truncation coverage on screen | `compat-views.test.ts` "step 7": the validation report (`/import/[id]`) shows a Source text coverage section from the conversion's `V5_TEXT_CAPPED` diagnostics, nothing when there are none, and says the coverage is unknown when a package has no conversion report; `compat.test.ts` "text cut short by the source export"; the probes' `textCapNotice` (newer 576 of 2,049; JSON 741 of 4,466; v5 none) | PASS on synthetic pages; no real-data browser run |
| 8. A reused ref with another original | `compat.test.ts` "a ref reused for another original across generations"; `src/lib/local-case/user-work.test.ts` "a reused ref does not carry them"; the `ess-newer` probe against the v5 package (715 of 1,212 shared refs name another original; their v5 anchors re-attach by fingerprint, 576 exactly and 139 ambiguous, and none follows the ref) | PASS |
| 9. Refuse unrecognized formats | `compat.test.ts` "generation detection" | PASS: nothing is converted, and the input is untouched. A refused click import is recorded as a rejected import with the converter's diagnostics (`APP_CONVERSION_REFUSED`), and the received HTML is kept privately under the data directory (`refused-inputs/`); `case-pack.test.ts` "records a refused conversion". |
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
