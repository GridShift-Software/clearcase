# Quantum & Interest

The quantum summary of a results version: the imported amount due with its source ref and date, a link to the latest computation's document, the invoice count and the imported gross invoiced figure, the running amount-due chart and series (latest first), the invoice ledger with its CSV export, and the charging and statement counts with a link to the charging calculations in the chronology. Imported figures are shown as given; when the imported count or gross disagrees with the ledger rows, a flag shows both.

## Sub-features

- `quantum-kpis` shows the four KPI cards (`.kpi`: label, value, caption); captions that v5 hard-coded come from view-content.
- `quantum-reconcile` flags (`#reconcile-flag`) an imported invoice count or gross that differs from the ledger rows.
- `quantum-series` lists the amount-due series latest first (`#amount-due-series`), each row linking to its document.
- `quantum-ledger-export` downloads every ledger row as `invoices.csv` (`#export-invoices`).
- `quantum-charging` opens the chronology filtered by type only (`#charging-link`).

## How to get to it (user POV)

- Choose `Quantum & Interest` (`#nav-quantum_tab`) in the case navigation, or under `Go to` on the overview.
- Open `/v/<rv>/quantum/quantum_tab`.

## Driving it with verify-clearcase

Preconditions: `activate` passed on a synthetic case (`tests/e2e/quantum/lib.mjs` `quantumCase` edits the quantum dataset so the imported count and gross disagree with three ledger rows).

- **Open.** *Not yet driven by the skill runner; `tests/e2e/quantum/suite.mjs` drives it.* Choose `#nav-quantum_tab`. `main[data-ready=quantum_tab]` appears, the heading `Quantum & Interest` has focus and the title is `Quantum & Interest · <case> · ClearCase`.
- **Reconciliation.** `#reconcile-flag` names both the imported figure and the ledger's (`Q1-INVOICE-TOTALS`).
- **Links.** The `Latest computation` KPI holds `a.cite` `Open source PDF` to `/v/<rv>/doc/<headline_ref>`; `#charging-link` is `/v/<rv>/chronology?type=charging+calculation` (`Q-LINKS`).

## Gotchas

- Every document link goes by ref through the document-row contract (`resolvableRefs`), never by `url`; an unknown ref renders as `span.cite-broken`.
- The KPI cards are `div.kpi` with `.k`, `.v`, `.s`, as v5 lays them out, so the parity extractor reads both sides alike.
