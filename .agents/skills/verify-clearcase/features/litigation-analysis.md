# Legality & SIU Risk and Cause of Action

Two read-only views of authored analysis (GRS-18). Legality shows the risk narrative, the documents in the bundle linked by ref to their document pages (a ref missing from the version renders broken), the scenarios with v5's likelihood chip (`/base/i` ok, else `/material/i` danger, else warn) and the factors. Cause of Action lists each element with what must be proved, the evidence (free text), the witness as stated (never linked) and "open →" to the named view; an id that names no view is text, not a link.

## Sub-features

- `legality-docs` `#legality-docs` rows by ref with `a.cite` "open ↗" to `/v/<rv>/doc/<ref>`.
- `legality-chips` `.badge[data-chip=ok|danger|warn]` per scenario.
- `elements-trace` `td[data-witness]` plain text; `a[data-target=<view id>]` "open →"; `[data-unknown-view]` for an unknown id.
- `analysis-scope` the "Source and scope" note: supplied analysis, not verified.

## How to get to it (user POV)

- Choose `Legality & SIU Risk` (`#nav-legality_tab`) or `Cause of Action` (`#nav-elements_tab`) under Litigation strategy, or open `/v/<rv>/litigation/legality_tab` or `/litigation/elements_tab`.

## Driving it with verify-clearcase

Preconditions:

- `activate` passed on a synthetic case with `DATA.lit.legality` and `DATA.lit.elements` (`tests/e2e/litigation/lib/cases.mjs`).

- **Inspect a scenario and its evidence.** *Not yet driven by verify-clearcase* (`tests/e2e/litigation/suite.mjs` `S3-legality`). Read the chips; press the first `#legality-docs a.cite`: `main[data-ready=doc:OD-001]`.
- **Trace an element to its witness.** *Not yet driven* (`S4-elements`). Read `td[data-witness]`; press `a[data-target=chronology]`: the chronology opens with its heading focused.
- **Proof.** The suite's scenario JSON files.

## Gotchas

- The documents card caption and the scenarios' last column heading carried case wording in v5 that view-content does not carry yet; the app shows neutral wording (register IDR-323, IDR-324).
- The Cause of Action columns come from view-content (`elements_tab.columns`); without all five the app shows neutral headings.
