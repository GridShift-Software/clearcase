# Literal expected examples

Acceptance item 3. Each example names an input, a predicate and the expected result. `source` is what the v5 reference shows today. Where v5 is wrong, a separate `rewrite` expectation gives the result the new implementation must produce instead, with the source defect or audit finding that justifies the difference ([defects.md](defects.md), [audit-dispositions.md](audit-dispositions.md)).

## Where the literals live

The authoritative file is local and case-bearing: `<fixture root>/v5-002/expected/expected-examples.json` (schema `clearcase-v5-expected-examples/1`), version 2 with **sha256 `f23fcdfddffe8ec19b5b71b894f362ac006b01bace0668440fb2d84010d7e931`**. The profile `scripts/fixtures/profiles/v5-002.json` pins the same digest. `python3 scripts/fixtures/inventory.py --verify` refuses a different file, recomputes every example from the fixture and fails on any difference. Its per-example results go to `<fixture root>/v5-002/inventory/<source>/examples.json`.

Values below are committed only when they are synthetic or opaque (counts, ref IDs, chosen inputs, computed figures). Paths, file names, titles, amounts and dates taken from documents stay in the local file. Every chosen date is checked against the fixture's dates by `scripts/fixtures/leak_check.py`; version 2 replaced the version 1 interest inputs (a rate equal to the code's hard-coded default and dates that equal case dates) and one deadline date that equals a case date, and the three changed examples were confirmed on screen again.

## Fixed clock

Date-sensitive examples use the clock **2026-10-08** in timezone **UTC**. The screen capture freezes `Date` to `2026-10-08T09:00:00Z` and overrides the browser timezone to UTC (see [baseline.md](baseline.md)). v5 computes countdowns from local midnight, so a different timezone can shift a result by one day near midnight; DST zones can also shift the interest calculator's day count by one hour (it divides a local-time difference by 86,400,000).

## Examples

| Key | Kind | Input | Predicate | Expected `source` | Expected `rewrite` | UI check |
| --- | --- | --- | --- | --- | --- | --- |
| `chronology-filter-correspondence-email` | filter | Chronology, bundle Correspondence, type `email`, default sort (date ascending, stable, empty dates first) | count, first three refs, last ref | 469 rows; first `EM-0474`, `EM-0475`, `EM-0398`; last `EM-0397` | same | first three refs confirmed on screen |
| `chronology-filter-text-extracted` | filter | Text `invoice` (case-insensitive substring over filename, ref, subject, sender, excerpt), text status `extracted` | count, first three, last | 573 rows; first `OD-039`, `OD-040`, `OD-041`; last `EM-0389` | same | no |
| `chronology-filter-additional-bundle` | filter | Bundle `Additional` (the 127 VDM-/AD- rows) | count and whether the bundle select offers it | filter logic matches 127 rows (first `VDM-002`, `VDM-004`, `VDM-017`; last `AD-01`) but the select offers only `Original`, `Supplementary`, `Correspondence`, `Pleadings` | the same 127 rows, with the option offered (S-bundle4) | option list confirmed on screen |
| `chronology-sort-amount-desc` | filter | Bundle Original, sort by amount descending (`parseFloat`, empty = 0, ties keep input order) | count, first three, last | 605 rows; first `OD-037`, `OD-510`, `OD-031`; last `OD-598` | same | no |
| `citation-timeline-event-0` | citation | `DATA.timeline.events[0]` | its `{ref,url}` equals the chronology row's url; the url resolves inside the case folder to one existing original; size, CRC-32 and sha256 of that file | local file (ref, both urls, path, size, CRC-32, sha256) | same | timeline screen (lane 8) shows the link |
| `citation-defence-doc-0-0` | citation | `DATA.defenceMatrix[0].docs[0]` | as above | local file | same | Defence & Rebuttal screen shows the link |
| `citation-unflagged-utf8-name` | citation | The chronology row whose original has a non-ASCII name stored without the zip UTF-8 flag | resolves only when the zip name is re-decoded as UTF-8 | local file | same | no |
| `interest-simple` | calculation | Interest Recalculator: capital 100000, rate 10 (synthetic), Simple, from 2004-02-03 to 2005-02-03 (366 days, across 29 February) | days, years label, formatted capital, interest, total | 366 days; `1.00` yrs; `R 100 000.00`; interest `R 10 020.53`; total `R 110 020.53` | same | values confirmed on screen |
| `interest-compound` | calculation | As above, Compound (monthly): total = P·(1 + r/1200)^(12·days/365.25) | as above | interest `R 10 493.90`; total `R 110 493.90` | same | values confirmed on screen |
| `prescription-as-of-clock` | calculation | All 306 `DATA.lit.prescription` rows; as-of date = clock | rows; rows with prescDate = invoice date + 3 years; rows labelled "Relies on interruption"; rows whose label equals `prescDate < interestBasis.headline_date` | 306; 306; 269; 306 (labels frozen against the headline date) | as of 2026-10-08, 276 rows have prescDate on or before the as-of date (BA-01; legal rule to be approved) | no |
| `deadline-countdown-fixed-clock` | deadline | Clock 2026-10-08 UTC; deadlines (stored order) E 2026-10-16, A 2026-10-01, C 2026-10-08, D 2026-10-15, B 2026-10-07, titles `Synthetic A`…`E` | table order, countdown text, badge class | A `7d ago` b-mut; B `1d ago` b-mut; C `today` b-dang; D `in 7d` b-warn; E `in 8d` b-ok | same | all five rows confirmed on screen (lane 9) |
| `deadline-delete-shown-row` | user work | Store `[{later, 2026-12-03}, {earlier, 2026-11-01}]` (title, date, cat, note); click Delete on the first row shown (earlier) | persisted `ess_dcs_deadlines_v1` | `[{"title":"Synthetic earlier","date":"2026-11-01","cat":"Hearing","note":""}]` (the wrong row was deleted) | `[{"title":"Synthetic later","date":"2026-12-03","cat":"Filing","note":""}]` (S-deadlines_tab-1) | persisted value confirmed |
| `ledger-privilege-add-add-delete` | user work | Privilege Log: add {OD-002, 2026-10-01, Synthetic entry one, Legal advice}; add with every field empty; add {SD-010, empty date, Synthetic entry two, Litigation}; delete row 1 | persisted `ess_dcs_privilege_v1` (every value a string; an all-empty add is ignored; rows keep insertion order) | `[{"ref":"SD-010","date":"","desc":"Synthetic entry two","basis":"Litigation"}]` | same | persisted value confirmed |

"UI check" means the value was observed in the v5 page itself, opened offline under `unshare -rn` with the fixed clock, and matched the expectation (`.orchestration/reports/CC-01/screens/capture.json` and, for the three version 2 inputs, `.orchestration/reports/CC-01/r2/screens/capture.json`; local). The expectations were derived from the code statically and computed with the reviewed ports in `scripts/fixtures/v5fixture/examples.py`; the UI observation only confirms them. Data was never obtained by executing the archive.

## Adding an example

Add the input and description to the local file, compute the expectation with the port (or extend the port, citing the v5 lines), confirm it in the UI where the behavior is interactive, then record the new file sha256 here and in the profile. A changed example file without a changed digest fails `--verify`.
