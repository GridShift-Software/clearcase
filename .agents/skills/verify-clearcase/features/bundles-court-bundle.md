# Court Bundle (bundles)

The Court Bundle view lists the imported bundles (`bundles`) with items, pages and status, edits the index header (saved per case over the imported defaults), shows one bundle's index, items with their source extents and page numbers, and exports Word indexes (one bundle, or all bundles in one document) and a printed index. The bundle builder (PDF assembly) is not in this version.

## Sub-features

- `court-list` KPIs, the bundles table (`Open`, `Word`), and the composition note.
- `court-header` eight header fields; `Save header`, `Restore matter defaults`, `Clear all (use placeholders)`.
- `court-index` `?b=<no>&tab=index`: the index preview, `Download Word (.docx)`, `Print index`.
- `court-items` `?b=<no>&tab=items`: items, `Extracted from` links (document page at the part's first page), `verify page <n>`.
- `court-view` `?b=<no>&tab=view`: the bundle PDF when indexed, else says it is not served.
- `court-word-all` `All indexes (Word)`.
- `court-builder` `Build a bundle`: an explicit "not available in this version" state.

## How to get to it (user POV)

- Choose `Court Bundle` (`#nav-court_bundle_tab`), or open `/v/<rv>/bundles/court_bundle_tab`.

## Driving it with verify-clearcase

- **Open.** `main[data-ready=court_bundle_tab]`; h1 `Court Bundle`; `#cb-list tbody tr` per bundle.
- **Header.** Fill `#cbh_<key>`, choose `#cb-save`; `main[data-busy="0"]` when saved. A failed save shows `#cb-error` and keeps all eight values.
- **Index.** Open a row (`Open`); `#cbindexdoc` shows the header and `table.cbixt`; `#cb-word` downloads `Index_<no>_<name>.docx`.
- **Builder.** `#cb-build` shows `#cb-builder-state`.

## Gotchas

- Bundle, index and extract PDFs are not package assets yet: they are named with `not in the verified index; not served`.
- Word hyperlinks into the bundle PDFs are not written (the PDFs are not served).
