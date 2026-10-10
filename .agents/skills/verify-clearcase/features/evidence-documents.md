# Documents (evidence)

Documents lists one bundle's document rows at a time, 60 per page, with a filter over file name, ref, subject and excerpt, a tally of document types and a link to each document's page. Every imported bundle has a button (v5 offered four). Rows are ordered by type, then date (undated first), as the page says. A URL value the controls cannot show is said, never silently applied: an unknown bundle (`#unknown-bundle`, the first bundle is shown), a filter over 500 characters (`#filter-too-long`, not applied) and a page that is not shown (`#page-notice`). The empty-named bundle is the button `(no bundle)`, URL value `~`.

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
- **Bundle.** Choose the button whose label starts with a bundle name (each carries its URL value in `data-bundle`). `main[data-bundle]` names it; `#documents-table tbody tr[data-ref]` lists that bundle's rows.
- **Filter.** Type into `#doc-filter`. Wait for `main[data-q]` to equal the text and `main[data-busy]` to be absent. The URL gains `?q=` and loses `page`.
- **Pages.** Choose Next in `#documents-pager`. `main[data-page]` advances; the pager reads `Page n / m` and `Showing a–b of N`.

## Gotchas

- The server filters and sends one page; never wait for the first row alone, wait for `main[data-page]`, `data-bundle` or `data-q` and no `data-busy`.
- Bundle URL values are encoded: the empty name is `~`, and a name starting with `~` gains one more.
- State changes replace the history entry; Back from a document returns to the list as it was.
- The Doc link opens the document page (`open ↗`), whose Open control opens the original: the two-click flow.
