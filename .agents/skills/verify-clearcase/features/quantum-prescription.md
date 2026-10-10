# Prescription

The imported prescription list (invoice, invoice date, imported prescription date and risk label) with v5's text and risk filters, pages of 80 and a CSV export, plus the BA-01 arithmetic: how many imported dates equal invoice date + 3 years (29 February to 28 February), how many fall on or before the as-of date from the clock, and an As-of status per row. Arithmetic only: the legal rule is not approved. The imported summary note is labelled as unchecked narrative and the summary KPIs are flagged when they contradict the rows.

## Sub-features

- `presc-filter` filters by text (`#pr-q`, over "no ref") and risk (`#pr-risk`); the filter and page live in the URL and the controls show them.
- `presc-pages` pages through `#pr-pager` (`Prev`, `Page n / m`, `Next`, `Showing a–b of N`).
- `presc-export` downloads the rows shown, filtered and in order, as `prescription.csv`.
- `presc-arithmetic` shows `#arith-plus3`, `#arith-asof` and `#arith-caution` in `#presc-arithmetic`, and `[data-as-of]` per row.
- `presc-narrative` labels the imported note (`#note-imported`) and flags a contradicting summary (`#summary-flag`).

## How to get to it (user POV)

- Choose `Prescription` (`#nav-prescription_tab`).
- Open `/v/<rv>/quantum/prescription_tab?q=…&risk=…&page=…`.

## Driving it with verify-clearcase

- **Arithmetic.** *Driven by `tests/e2e/quantum/suite.mjs`.* With `CLEARCASE_FIXED_NOW=2026-10-08T09:00:00Z`, `#arith-asof` names the as-of date `2026-10-08` (`Q4-LEAP-MONTH-END`, `Q10-FIXED-CLOCK`).
- **Filter and export.** Open `?risk=Not+yet+due+to+prescribe`; `#pr-risk` shows it and `#export-presc` writes exactly the shown rows (`Q7-EXPORT-PRESCRIPTION`).
- **Narrative.** `.narrative` holds the imported note unchanged, `#note-imported` labels it, `#summary-flag` names the contradiction (`Q9-NARRATIVE`).

## Gotchas

- The as-of date is computed on the server from `now()` (its South African calendar date, UTC+2, whatever the host time zone); never read the browser clock.
- Filters replace the history entry (shallow routing); Back from a document restores the filtered URL.
