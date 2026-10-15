---
status: accepted
date: 2026-10-13
---

# The local app converts a case pack itself

After the V1 demo review video on 13 October 2026, the user asked for import by clicking (GRS-70). Before it, the operator extracted the case pack, ran `bun run --bun convert` in a terminal and typed two paths. Now the operator picks the case pack (the `.zip` as received, or the folder it was extracted to) and a storage folder in a folder browser. The app extracts the pack, finds the workspace HTML, converts it into a results package and validates it. Candidate preview and activation are unchanged.

This changes the flow in [ADR 0004](0004-local-rescan-backup-and-case-import.md), where the operator imports a processed results ZIP. The local app now runs the converter on the operator's machine. Importing a results package by its path still works.

These limits hold (`src/lib/local-case/case-pack.server.ts`):

- The folder browser (`/api/browse`) lists only subfolders and `.zip` files with their sizes. It never reads file contents, and the app refuses a cross-site request to it.
- Nothing is written into a case folder, the data directory or the folder the server was started from. The extracted pack and the results package go into the storage folder, `~/ClearCase` unless the operator picks another.
- Extraction refuses unsafe archive entries and a pack that needs more space than is free. The app reuses an earlier extraction only when every file matches the pack's CRC-32. Otherwise it refuses and names the file that differs.
- A failed or cancelled import removes the folders it created, and the active version stays active.

Considered option: keeping the terminal conversion and typed paths. The user rejected it as unusable.

## Consequences

- The converter's limits are now the import's limits. A pack the converter cannot read fails with a message and imports nothing.
- This record does not cover hosted intake, the hosted results-import endpoint or any transfer of case data off the machine.

Affects GRS-70 (PR #42) and the demo build (PR #43), both open for review on 15 October 2026.
