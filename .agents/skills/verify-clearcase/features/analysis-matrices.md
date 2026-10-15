# Contradiction Tracker, Risk Matrix, Defence & Rebuttal and Witnesses

Four read-only analysis tables from the package (GRS-15): contradiction KPIs, consistency checks and categories with source chips; risks with likelihood and impact chips; defence points with their evidence, document chips, rebuttal and free-text refs; witnesses with their will-say.

## Sub-features

- `contradictions-categories`: severity badge (`HIGH`, `MEDIUM`, `LOW`, else `INFO`), title and `N item(s)` per category in data order; source chips `a.cite` labelled `<ref> · R <amount>` open the document.
- `contradictions-export`: `#export-csv` downloads `category,severity,item,detail,spread,refs`, named by the package (`contradictions_tab.exportFileName` in view-content), else `contradictions.csv` with a note beside the button (`[data-export-note]`).
- `risk-matrix`: chips `b-dang` for exactly `High`, `b-warn` for `Medium`, else `b-ok`.
- `defence-matrix`: headings from view-content (neutral without it); document chips; the `Refs` column and the CSV's last `refs` column (S-vdm_matrix_tab-1); `#export-csv` downloads under the package's `vdm_matrix_tab.exportFileName` with its five `exportColumns` keys then `refs`; without them, `defence_rebuttal.csv` and `point,case,evidence,documents,rebuttal,refs`, each with a note (`[data-export-note]`).
- `witnesses`: the will-say renders through `Narrative.svelte`; only `[[REF]]` tokens link, never names.
- `narrow-screen` (BA-21): below 40rem each table row becomes a card whose cells carry their column label; on analysis pages the navigation stacks above the content.

## How to get to it (user POV)

- Choose `#nav-contradictions_tab`, `#nav-risk_matrix_tab`, `#nav-vdm_matrix_tab` or `#nav-witness_tab`, or open `/v/<rv>/analysis/<view-id>`.

## Driving it with verify-clearcase

Preconditions:

- `activate` passed on the synthetic case. The plain synthetic case that `lib/inner.mjs` builds (`tests/case-package/fixtures/synth.ts`) already fills every analysis view with one to three rows; the analysis e2e suite extends it with `analysisData` (`tests/e2e/analysis/lib.mjs`).

- **Open.** *Not yet driven* (no `lib/drive.mjs` step yet; proved by the analysis e2e suite). Choose the navigation entry; wait for `main[data-ready=<view-id>]`; the heading is the label and has focus.
- **Trace a defence.** *Not yet driven* (no `lib/drive.mjs` step yet; proved by the analysis e2e suite). In `#defence-table`, choose `.chips a.cite`: `main[data-ready="doc:<ref>"]`.
- **Export.** *Not yet driven* (no `lib/drive.mjs` step yet; proved by the analysis e2e suite). Choose `#export-csv`; the download is a Blob anchor (capture it as the parity harness does, by wrapping `URL.createObjectURL` and `HTMLAnchorElement.prototype.click`). Read the expected name and keys from the built package's `datasets/view-content.json`, never from a literal.
- **Narrow.** *Not yet driven* (no `lib/drive.mjs` step yet; proved by the analysis e2e suite). Set the viewport to 320 px (`Emulation.setDeviceMetricsOverride`); `document.documentElement.scrollWidth` stays 320 and `table.an-stack` is `display: block`.
- **Proof.** Until a drive step exists, the proof is `tests/e2e/analysis/suite.mjs`, scenarios AN-05, AN-06, AN-07, AN-09 and AN-11 (neutral export names, keys and notes); `screens/<view>-<320|390|1280>.png`.

## Gotchas

- The KPIs are the package's own figures (`total`, `highCount`, `byCat`), as v5 shows them; they are not recounted.
- An empty `contradictions.categories` shows `#contradictions-none`; a package without the dataset shows `#contradictions-empty`.
- Chip labels end in an amount only when the ref has one.
- `main[data-ready=<view-id>]` is already in the server-rendered HTML, because the data is complete there. Wait for `main[data-hydrated]` as well before clicking a control (checkbox, Export CSV, Print / PDF), or the click may land before the page handles it.
