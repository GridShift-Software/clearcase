# Advanced Search (evidence)

Advanced Search finds documents by text (file name, ref, subject, sender, recipients and the indexed excerpt, not the full text), bundle, type, sender, a date interval, an amount interval and text status. Results keep register order, 50 per page; the export holds every result in the same order. A reversed date or amount interval, or an amount bound that is not a number, is rejected with a message, distinct from a valid search that matches nothing. The page states its coverage, counted from the rows.

## Sub-features

- `search-run` submits the form (the search is the URL).
- `search-pages` pages through results with the query kept.
- `search-invalid` rejects reversed or malformed intervals (`#search-invalid`).
- `search-empty` shows a genuine empty result (`#search-empty`).
- `search-export` downloads `search.csv` for the submitted search.
- `search-actions` extracts action-item phrases from the submitted search.

## How to get to it (user POV)

- Choose `Advanced Search` (`#nav-search`), or open `/v/<rv>/evidence/search?q=…&bundle=…` directly.

## Driving it with verify-clearcase

- **Open.** Choose `#nav-search`. `main[data-ready=search]`, `data-result=idle`; the title is `Advanced Search · <case> · ClearCase` and the heading has focus. `#search-coverage` carries `data-documents`, `data-with-excerpt`, `data-max-excerpt`, `data-none` and `data-pending`.
- **Search.** Fill `#sq` (and `#sb`, `#st`, `#ss`, `#sf`, `#sto`, `#samin`, `#samax`, `#sst`), choose `#search-run`, wait for `main[data-result]` other than `idle` and no `data-busy`. `results` lists `#search-table tbody tr[data-ref]` and `#search-count`; `empty` adds `#search-empty`; `invalid` shows `#search-invalid` and no table.
- **Export.** Choose `#search-export`; the download `search.csv` has v5's columns and the result order.

## Gotchas

- `main[data-search]` is the submitted search's query string; compare it to know which search the page shows.
- Export and action items use the submitted search, not unsaved form edits (v5's behaviour).
