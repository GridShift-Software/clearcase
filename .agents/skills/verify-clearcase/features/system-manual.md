# System: Manual

The Manual explains, offline, how the workspace works: starting and importing a case, what search covers (only documents with extracted text; the rest by ref, filename and metadata), the Freshness card and rescans, saved work and backups (binaries are not included), and checking links to originals. Its badges count this version's documents (with rescan additions), emails, people, documents without text and pending ones; its two lists, the documents needing OCR and a check of the package's link sample against the case folder, are links, so they work without JavaScript and Back returns to them.

## Sub-features

- `manual-badges` shows Documents (with "+k via rescan"), Emails, People, Scanned (none) and Pending.
- `manual-ocr` lists the documents without extracted text (`?list=ocr`).
- `manual-verify` checks each link of the package's link sample against the case folder now (`?list=links`).
- `manual-links` links to Rescan & Update and Backup / Restore.

## How to get to it (user POV)

- `Manual` (`#nav-manual`) in the case navigation, under System.

## Driving it with verify-clearcase

Preconditions:

- `system-rescan` passed: one rescan addition.

- **Badges and link check.** Choose `#nav-manual`, then `Verify link sample` (`#manual-verify`). Step `system-manual`. `#manual-badges` reads `Documents 8 (+1 via rescan)`, and `#manual-verify-result` is `1 of 1 found in the case folder.` with `tr[data-result=found]`.
- **Back keeps the place.** Choose `#manual-rescan`, then Back. Step `system-manual`. The manual shows `#manual-link-list` again and focus is on the page heading (`[data-page-heading]`).
- **OCR list.** *Covered in `tests/e2e/system` (SY9).* `#manual-ocr` opens `#manual-ocr-list`.
- **Proof.** The screenshot `system-manual-links`.

## Gotchas

- With networking disabled every link stays on 127.0.0.1; the manual has no external link.
- The badge counts come from the register rows, like the overview tiles, not from the source's build metadata.
