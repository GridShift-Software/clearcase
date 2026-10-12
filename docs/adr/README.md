# Decision records

These ADRs record the product decisions the user confirmed on 11 and 12 October 2026. The 12 October answers refer to the orchestrator's 23-item V1 questionnaire. Each record says whether a decision is accepted, conditional or still pending, and names the issues and pull requests it affects.

| ADR | Decision | Status | Affects |
| --- | --- | --- | --- |
| [0001](0001-v5-parity-and-calculation-rules.md) | Full v5 parity and calculation rules | Accepted, 11 Oct | GRS-16 (#16), GRS-17 (#18), GRS-18 (#17), GRS-21 |
| [0002](0002-approved-v1-behaviour-corrections.md) | Approved V1 behaviour corrections (items 3–6 and 8) | Accepted, 12 Oct | GRS-14 (#19), GRS-15 (#20), GRS-16 (#16), GRS-17 (#18), GRS-18 (#17), GRS-19 (#22), GRS-45 |
| [0003](0003-analysis-additions-behind-a-flag.md) | Analysis additions behind a default-off flag (item 2) | Conditional, 12 Oct | GRS-15 (#20), GRS-48 |
| [0004](0004-local-rescan-backup-and-case-import.md) | Local rescan, backup and per-case import/update (item 7) | Accepted, 12 Oct; importer design pending | GRS-20 (#21), GRS-47 |
| [0005](0005-numeric-monetary-csv-credits.md) | Validated monetary credits stay numeric in CSV (item 9, option A) | Accepted, 12 Oct; implementation pending | GRS-49, GRS-13 (#15) |

## What these records do not decide

- **Unanswered questions.** Item 1 (evidence) and items 10–23 (V2 and launch) have no answer. Nothing in these records approves them. Dates and cost figures in older V2 drafts are not current evidence.
- **Release approval.** Accepting a decision does not waive the diff review, the external PR review, `bun run --bun gate`, the parity gate or any milestone gate. Each change still has to pass them at its exact SHA.
- **Register approval.** Product-visible entries in `docs/reference/parity/intentional-differences.json` keep `approvedBy: null` until the user approves them in the relevant PR. These ADRs do not fill that field.
- **Production and V2.** No record authorises production changes, hosted implementation, transfer of real case data by agents, or any unresolved V2 choice.
- **Missing links.** Missing package-file links (GRS-45) and missing captions remain defects to fix. They are not accepted gaps.

## Adding a record

Number the next ADR sequentially, keep it short, and add a row above. Supersede a record by adding a new one and marking the old one `superseded by ADR-NNNN`; don't rewrite history.
