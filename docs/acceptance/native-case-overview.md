# Native case overview, chronology and case notes (prepared, unverified)

Status: PREPARED. Focused unit checks with unit doubles pass at the commit that adds this page. Nothing here is gate, workerd, browser, storage-adapter or native evidence. It certifies nothing about the 42 views.

## What the hosted case pages do

- `/cases/[caseId]` reads the case with the authorized case read (`store.getCase`) before any other metadata. Then three parts load side by side: results, originals (`assets.originals`) and the user's notes (`userWork.notesFor`). A fault in one part shows only that part as unavailable. A denial anywhere fails the page, and an inaccessible case reads as 404.
- Results appear only for the case's current published version. The store must name that version active (`activeVersionId`) and it must pass `verifyVersion`. In every other state the page shows the designed `ResultsState`: pending (no publication), withdrawn, or unavailable. It never shows stale content or a client's private candidate.
- The overview shows the stored overview model and the store's derived counts (`documentCounts`). Its subtitle is filled from the package's view content. Tallies reach the page as `[name, count]` entries, so a dataset name never becomes an object key.
- `/cases/[caseId]/views/[resultsVersion]/chronology` is the version route. Any version other than the current published one is 404, including superseded, malformed, withdrawn and never-published versions. Search and filters are GET parameters and use the local chronology's own `queryRows` semantics. A row links to an original only when `assets.originals` lists that asset id. The link never guesses an asset.
- `/cases/[caseId]/notes` shows the user's notes and saves them through `AsyncUserWork` only. A note can be on the case, or an annotation on a document of the current published version (`anchorFor`). Notes load and save while results are pending, withdrawn or unavailable.
  - A write carries the operation id the form was rendered with.
  - A stale or moved save answers 409. The user's text is kept, and so is the server's current version and text.
  - A fault answers 503. It keeps the text and the operation id, so saving again repeats the same write.
  - A denied write answers 403.
  - Nothing is stored in the browser or in memory instead of the server.
- Case text is shown as escaped text with invisible characters revealed. This covers labels, filenames, subjects, tally names and note bodies. No page renders dataset text as HTML.

## Code

- `src/lib/views/hosted/`: `case.server.ts` (case read, current version, overview, chronology), `notes.server.ts`, `paths.ts`, `model.ts`, `display.ts`, `CaseOverview.svelte`, `NoteText.svelte`.
- `deploy/client/routes/cases/[caseId]/` (`+page.server.ts` and `+page.svelte`, plus `views/[resultsVersion]/chronology/` and `notes/`).
- Tests: `tests/hosted-smoke/case-overview/`. The root Vitest include does not list them yet, so run them alone with `bun --bun x vitest run --config tests/hosted-smoke/case-overview/vitest.config.ts`.

## Not covered here

- Originals byte serving (`originals/**`) and the document viewer (`v/**`) belong to the PDF owner. Chronology refs therefore show as citations without a document-viewer link.
- The hosted user-work, results and asset adapters are not part of this change. In the hosted-gate artifact, user work and results stay unavailable, so these pages show their unavailable states there.
- The root shell, navigation and runtime injection belong to the parent.
