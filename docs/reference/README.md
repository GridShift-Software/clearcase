# v5 reference baseline

GRS-9 (CC-01) freezes the v5 sample as the reference that GRS-10 (package contract), GRS-11 (reference gate) and GRS-12 (pilot) are built and gated against. Everything here is reproducible from the designated archive with the commands in [tests/fixtures/README.md](../../tests/fixtures/README.md).

| Document | Contents |
| --- | --- |
| [baseline.md](baseline.md) | Fingerprints, record and view counts, link/missing/duplicate results, variant separation, screens, performance baseline |
| [v5-summary.json](v5-summary.json) | Machine-readable counts, field names, nav entries and per-view static counts; `--verify` regenerates and compares it |
| [view-checklist.md](view-checklist.md) | All 42 views: imported datasets, user-work stores, state, actions, exports, derived rules, originals, source defects |
| [expected-examples.md](expected-examples.md) | Literal examples for filters, citations, calculations, a fixed-clock deadline and user-work workflows, with source and rewrite expectations |
| [defects.md](defects.md) | Source defects against rewrite defects, and the cross-cutting dispositions |
| [audit-dispositions.md](audit-dispositions.md) | BA-01 to BA-21: owner, applicable views, correction or disclosure, deferral, required evidence |
| [route-map.md](route-map.md) | The 42 v5 views against the production audit's routes, production-only capabilities and newer-export datasets |

Committed here: fingerprints, counts, dataset and field names, nav ids and labels, store keys, opaque ref IDs, synthetic example values and generic finding descriptions. Kept local under the fixture root and `.orchestration/reports/CC-01/`: originals, extracted trees, file names and paths, titles, names, amounts, any date taken from a document or event, narrative text and paraphrase of it, screenshots and ref-to-file mappings. The only dates committed are the v5 build date, the fixed test clock and synthetic example dates. The generators of the checklist and route map pass every free-text value through `scripts/fixtures/v5fixture/redact.py`. `python3 scripts/fixtures/leak_check.py` fails if a tracked file contains a distinctive string from the local fixture or a date that equals any date in it (`--range BASE..HEAD` scans every commit in a range); string matching cannot see paraphrase, so committed prose is also read by hand.
