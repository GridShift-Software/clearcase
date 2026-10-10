# CaseLines (bundles)

CaseLines shows the consolidated court bundle named by the package (`view-content`), searches its page-text index (`caselines-index`) on the server, opens the bundle's document page at a page, links further case-folder files by path (saved per case) and keeps files added for the session as downloads only.

## Sub-features

- `caselines-open` `Open in app`, `Open in new tab`, `Download`: the bundle's document page when its path is indexed, else `not in the verified index; not served`.
- `caselines-search` `Search <n> pages` or Enter: pages with the phrase in page order, occurrences, snippets; each result opens the document page at that page.
- `caselines-coverage` `#cl-coverage` states what search covers: pages indexed, pages without text (listed).
- `caselines-goto` `Go to page` + `Open`.
- `caselines-link` `Link file (permanent)`: saved per case, resolved only by exact indexed path; `Remove`.
- `caselines-upload` drag and drop or `browse`: listed for the session with `Download` only (never opened in the app tab).

## How to get to it (user POV)

- Choose `CaseLines` (`#nav-caselines_tab`), or open `/v/<rv>/bundles/caselines_tab?q=<phrase>`.

## Driving it with verify-clearcase

- **Open.** `main[data-ready=caselines_tab]` (server-rendered), then `data-hydrated`; h1 `CaseLines`.
- **Search.** Type into `#cl-q`, press Enter; wait for `#cl-results[data-q="<phrase>"]`; read `#cl-summary` and `.cl-hit`. Click a hit: `/v/<rv>/doc/<ref>?page=<n>`.
- **Link.** Type into `#cl-path`, choose `#cl-link`; `#cl-docs li[data-row]` appears. A failed save shows `#cl-error` and keeps the typed path.

## Gotchas

- With no page-text index the page says search is not available; nothing falls back to the browser's PDF find.
