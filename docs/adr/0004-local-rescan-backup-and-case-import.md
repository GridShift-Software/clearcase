---
status: accepted
date: 2026-10-12
---

# Local rescan, backup and per-case import/update

On 12 October 2026 the user approved the item 7 behaviour for Rescan & Update, Backup / Restore and the Manual:

- Rescan only the registered folders. Use a quick metadata check by default and a full hash on request. Report additions, changes and removals.
- A backup holds all of one case's saved work: every user-work table, the case and version identity metadata, and the configuration needed to restore it. Restore is case-scoped, asks for confirmation and keeps a rollback copy first. Binaries are excluded: original files and results-package binaries are not included automatically, and the user has not decided to bundle them.
- The Manual and the rescan pages say that processing is manual and show how fresh the data is.

The user also added a per-case **Import data / Update data** section to V1, including for a case created before any data exists. The client sends new source files to the operator through the web intake, receives a processed results ZIP and imports that ZIP locally. The app should read originals from a directory the user chooses and keep its own data in internal app storage, so the user never has to reorganise their desktop.

This widens the V1 experience in the [product brief](../product-brief.md), which had the operator selecting a case folder. Considered option: requiring a fixed folder layout. The user rejected it to avoid moving their files.

## Consequences

- GRS-47 holds the importer design questions. The user deferred them, so agents ask none now.
- This record does not authorise web-intake or portal implementation, production changes, or agents transferring real case data. Hosted intake stays with the unanswered V2 work.

Affects GRS-20 (PR #21) and GRS-47.
