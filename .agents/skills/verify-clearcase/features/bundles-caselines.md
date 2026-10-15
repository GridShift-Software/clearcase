# CaseLines (bundles)

CaseLines shows the consolidated court bundle named by the package (`view-content`), searches its page-text index (`caselines-index`) on the server, opens the bundle's document page at a page, links further case-folder files by path (saved per case) and keeps files added for the session as downloads only.

## Sub-features

- `caselines-open` `Open in app`, `Open in new tab`, `Download`: the bundle's document page when its path is a document, its originals-site link when it is a package file on disk (GRS-45), else `not in the verified index; not served`.
- `caselines-search` `Search <n> pages` or Enter: pages with the phrase in page order, occurrences, snippets; each result opens the document page at that page.
- `caselines-coverage` `#cl-coverage` states what search covers: pages indexed, pages without text (listed).
- `caselines-goto` `Go to page` + `Open`.
- `caselines-link` `Link file (permanent)`: saved per case, resolved only by exact indexed path; `Remove`.
- `caselines-upload` drag and drop or `browse`: listed for the session with `Download` only (never opened in the app tab).

## How to get to it (user POV)

- Choose `CaseLines` (`#nav-caselines_tab`), or open `/v/<rv>/bundles/caselines_tab?q=<phrase>`.

## Driving it with verify-clearcase

Preconditions: `activate` passed on the synthetic case of `lib/inner.mjs` (`buildCase`, 7 rows); step `every-view` has opened this view once.

- **Open.** Step `every-view` (page and heading only). `main[data-ready=caselines_tab]` (server-rendered), then `data-hydrated`; h1 `CaseLines`.
- **Search.** *Not yet driven.* Type into `#cl-q`, press Enter; wait for `#cl-results[data-q="<phrase>"]`; read `#cl-summary` and `.cl-hit`. A hit links to the document page (`/v/<rv>/doc/<ref>?page=<n>`) only when the bundle resolves to a document, to the original with `#page=<n>` when it resolves to a package file, and nowhere otherwise. On the synthetic case the bundle is not in the case folder (`#cl-not-served`), so hits have no link.
- **Link.** *Not yet driven.* Type into `#cl-path`, choose `#cl-link`; `#cl-docs li[data-row]` appears. A failed save shows `#cl-error` and keeps the typed path.

## Gotchas

- With no page-text index the page says "This package has no page-text index, so the bundle cannot be searched here." and the button reads `Search unavailable (no page-text index)`; nothing falls back to the browser's PDF find.
