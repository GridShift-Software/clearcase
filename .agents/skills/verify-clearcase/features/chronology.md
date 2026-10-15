# Chronology

The chronology lists every document of a results version sorted by date (source order breaks ties; `/api/v/<rv>/chronology` keeps source order), with date, a date basis column when some row has one, ref, title, type, bundle, amount, text status and whether the original opens. The user can filter by text, bundle, type and text status (kept in the URL), sort by column, open a document, and export the filtered rows as CSV.

## Sub-features

- `chronology-list` lists every register row with a link to its document.
- `chronology-filter` filters by text, ref or filename, bundle, type and text status, with a live row count.
- `chronology-sort` sorts by date, ref, type, bundle or amount.
- `chronology-export` downloads the filtered rows as CSV, named by the package (`chronology.exportFileName` in view-content), else `chronology.csv` with a note beside the button (`[data-export-note]`).
- `chronology-back` returns from a document to the same filtered list.

## How to get to it (user POV)

- Choose `Chronology` (`#nav-chronology`) in the case navigation of any version page.
- Choose `Chronology` under `Go to` on the overview.
- Open `/v/<rv>/chronology?q=…&bundle=…` directly; filters come from the URL.

## Driving it with verify-clearcase

Preconditions:

- `activate` passed; the active version has 7 register rows.

- **Open the list.** Choose `#nav-chronology`. Step `chronology`. `main[data-ready=chronology]` appears, `#row-count[data-count]` is 7, `[data-ref=OD-001]` is listed and `#nav-chronology` is the `aria-current` entry.
- **Filter.** *Not yet driven.* Type `OD-00` into `#f-q`. `#row-count[data-count]` drops to the matching rows (OD-001 to OD-004) and the URL gains `?q=OD-00`.
- **Export.** *Not yet driven.* Choose `#export-csv`. The browser download (CDP `Browser.downloadWillBegin`) is named by the package's `chronology.exportFileName` (read the expected name from the built package's `datasets/view-content.json`, never from a literal) with no `[data-export-note]`; on a package without that field it is `chronology.csv` and `[data-export-note]` says a generic name is used. It holds one header and one line per filtered row.
- **Proof.** `screens/06-chronology.png`, with the count and refs in `inner.json`.

## Gotchas

- `#nav-chronology` carries the last filter query this tab saved (sessionStorage, `ViewNav.svelte`), so choosing it again restores those filters; compare paths, not full URLs.
- The list is loaded from `/api/v/<rv>/chronology` with an ETag. Wait for `main[data-ready=chronology]`, not for the first table row.
- `#row-count[data-count]` is the filtered count the user sees; assert on it as well as on the rendered `[data-ref]` rows, which a later grid change may window.
- Filters replace the history entry instead of pushing one. Back from a document returns to the filtered list, not to each filter state.
- The list is the document-row contract's projection (`listJson` of `src/lib/local-case/documents.server.ts`): the imported register in source order, then rows from registered providers (GRS-20's rescan). A provider row whose ref already names an imported document is dropped, never shown twice. A view that lists documents reads `documentRows`/`activeDocumentRows`, so its row count for the synthetic case must equal `#row-count[data-count]` here (7).
- The grid (`DataGrid.svelte`) sets column widths through CSS classes, not inline styles; assert on `[data-ref]` rows and `aria-sort`, not on widths.
