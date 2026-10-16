# Export validated monetary credits as numeric CSV values

Planning snapshot, 16 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-49/export-validated-monetary-credits-as-numeric-csv-values) is the execution authority.

User selected questionnaire item 9 option A on 12 October 2026. Validated monetary credit values such as -500 must export as numeric CSV cells so spreadsheet totals include them. Exempt only values accepted by the monetary parser; keep formula protection for free-text values, including formula starts after semicolon, tab, CR or LF in every column. Negative disbursement credits were already approved on 11 October. The shared CSV boundary is coordinator-owned; do not edit another active worktree. Acceptance: synthetic negative monetary credits remain numeric, malformed monetary strings are not exempted, and free-text formula protection remains intact. Verify behavior under Bun at the exact changed SHA.

Concrete write reservation: src/lib/components/csv.ts and src/lib/components/csv.test.ts. Keep the monetary exemption narrow and prove numeric credits versus hostile free text. Any additional monetary-parser caller change needs an explicit coordinator path handoff; no broad component rewrite.
