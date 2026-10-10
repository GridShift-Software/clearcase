# Interest Recalculator

Reproduces the interest on a capital figure: simple (exact) or compound monthly (v5's formula), Actual/365.25 on calendar dates counted in UTC, compared with the imported amount due. The rate default comes from the package's view-content; the From and To defaults from the imported interest basis. The inputs live in the URL query, so a reload gives the same result, and `Reset to defaults` returns to the package defaults. Invalid and reversed inputs are refused visibly with the typed text kept.

## Sub-features

- `interest-compute` submits `#ic-form` (GET: `p`, `r`, `m`, `from`, `to`) with `#ic-compute`; `#ic_out` shows Capital, Interest (n yrs), Total and the comparison line.
- `interest-validate` shows `#ic-error` for an amount outside the grammar, a missing rate or an invalid or reversed period.
- `interest-reset` (`#ic-reset`) returns to the defaults.
- `interest-narrative` labels the imported basis note (`#note-imported`).

## How to get to it (user POV)

- Choose `Interest Recalculator` (`#nav-interest_calc_tab`).
- Open `/v/<rv>/quantum/interest_calc_tab?p=100000&r=10&m=Simple&from=2004-02-03&to=2005-02-03` (the expected example `interest-simple`).

## Driving it with verify-clearcase

- *Driven by `tests/e2e/quantum/suite.mjs`*: the dated R1,000 year (`Q2-R100`: R 99.93 for 365 days, R 100.21 for 366), change, reload and reset (`Q3-DEFAULTS-INTEREST`), a two-day leap period (`Q4-LEAP-MONTH-END`), refusals (`Q5-INVALID-INTEREST`), identical output under the fixed clock (`Q10-FIXED-CLOCK`).

## Gotchas

- R100 for exactly one year is a library proof (`simpleInterestYears`); a dated year is 365 or 366 days on this basis.
- Wait for `location.search` to change and `#ic_out .kpi` (or `#ic-error`) to appear after Compute: the GET form is a client-side navigation.
