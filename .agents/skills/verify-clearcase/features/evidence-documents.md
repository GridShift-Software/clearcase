# Documents (evidence)

Documents lists one bundle's document rows at a time, 60 per page, with a filter over file name, ref, subject and excerpt, a tally of document types and a link to each document's page. Every imported bundle has a button (v5 offered four). Rows are ordered by type, then date (undated first), as the page says.

## Sub-features

- `documents-bundle` switches the bundle; the button counts come from the rows.
- `documents-filter` filters within the bundle and returns to page 1.
- `documents-pages` pages through 60 rows at a time with Prev and Next.
- `documents-back` returns from a document to the same bundle, filter and page.

## How to get to it (user POV)

- Choose `Documents` (`#nav-documents`) in the case navigation, or under `Go to` on the overview.
- Open `/v/<rv>/evidence/documents?bundle=…&q=…&page=…` directly; the state comes from the URL.

## Driving it with verify-clearcase

Preconditions: `activate` passed on a synthetic case.

- **Open.** Choose `#nav-documents`. `main[data-ready=documents]` appears, the title is `Documents · <case> · ClearCase` and the `h1[data-page-heading]` has focus.
- **Bundle.** Choose the button whose label starts with a bundle name. `main[data-bundle]` names it; `#documents-table tbody tr[data-ref]` lists that bundle's rows.
- **Filter.** Type into `#doc-filter`. Wait for `main[data-q]` to equal the text and `main[data-busy]` to be absent. The URL gains `?q=` and loses `page`.
- **Pages.** Choose Next in `#documents-pager`. `main[data-page]` advances; the pager reads `Page n / m` and `Showing a–b of N`.

## Gotchas

- The server filters and sends one page; never wait for the first row alone, wait for `main[data-page]`, `data-bundle` or `data-q` and no `data-busy`.
- State changes replace the history entry; Back from a document returns to the list as it was.
- The Doc link opens the document page (`open ↗`), whose Open control opens the original: the two-click flow.
