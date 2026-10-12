# Court Bundle (bundles)

The Court Bundle view lists the imported bundles (`bundles`) with items, pages and status, edits the index header (saved per case over the imported defaults), shows one bundle's index, items with their source extents and page numbers, and exports Word indexes (one bundle, or all bundles in one document) and a printed index. The bundle builder (PDF assembly) is not in this version.

## Sub-features

- `court-list` KPIs, the bundles table (`Open`, `Word`), and the composition note.
- `court-header` eight header fields; `Save header`, `Restore matter defaults`, `Clear all (use placeholders)`.
- `court-index` `?b=<no>&tab=index`: the index preview, `Download Word (.docx)`, `Print index`.
- `court-items` `?b=<no>&tab=items`: items, `Extracted from` links (document page at the part's first page), `verify page <n>`.
- `court-view` `?b=<no>&tab=view`: the bundle PDF when it is a document or a package file on disk, else says it is not served.
- `court-word-all` `All indexes (Word)`.
- `court-builder` `?view=build` (`Build a bundle`): pick PDFs, arrange items and page ranges, `Create Bundle` (one numbered PDF with its index, assembled in the page), `Index only (PDF)`, `Index (Word)`, `Save to the bundle list` (the item list is kept per case as `C<i>`; the PDF only for the session). Password-protected PDFs are refused with a message.
- `court-saved` a saved bundle's row in the list (`custom` badge, `Delete`); its PDF opens while the session lasts.

## How to get to it (user POV)

- Choose `Court Bundle` (`#nav-court_bundle_tab`), or open `/v/<rv>/bundles/court_bundle_tab`.

## Driving it with verify-clearcase

- **Open.** `main[data-ready=court_bundle_tab]` (server-rendered), then `data-hydrated`; h1 `Court Bundle`; `#cb-list tbody tr` per bundle.
- **Header.** Fill `#cbh_<key>`, choose `#cb-save`; `main[data-busy="0"]` when saved. A failed save shows `#cb-error` and keeps all eight values.
- **Index.** Open a row (`Open`); `#cbindexdoc` shows the header and `table.cbixt`; `#cb-word` downloads `Index_<no>_<name>.docx`.
- **Builder.** `#cb-build` opens it (`#cb-builder-h`). Pick files with CDP `DOM.setFileInputFiles` on `#cbbfile`; use only the synthetic set from `bun tests/bundles/fixtures/make-pdfs.mjs <dir>`. Items are `#cbb-items tr[data-item]`, `#cbbtotal` sums them, `#cbbname` names the bundle. `#cbbrun` → `#cbbdownload` (the PDF), `#cbbindex`, `#cbbword`; `#cbbsave` saves and opens `?b=C<i>`, and `#cbbsaved` shows the number after Back. A refused save shows `#cb-save-error`; a refused delete shows `[data-delete-error=<id>]`. Without JavaScript `#cb-builder-nojs` says the builder needs it.

## Gotchas

- Bundle, index and extract PDFs and source parts outside the register are package files (GRS-45, `P-` keys): they open in the originals site's viewer, with the page as `#page=N`, and download from it. One missing at import, or deleted or changed since, is named with `not in the verified index; not served`.
- Word hyperlinks into the bundle PDFs are not written (the PDFs are not served).
- After Create Bundle the built PDF shows in the page in `#cbbpreview`, a frame of the builder's own blob URL (CSP `frame-src blob:`, no sandbox: Chromium leaves a sandboxed PDF frame empty). `Open in a new tab` also shows it.
