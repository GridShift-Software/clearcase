# ClearCase user guide

How to run the local ClearCase workspace for one case: start it, import a case, know what search covers, keep the case folder in step, and back up your work. The same text, shortened, is the in-app Manual (System → Manual), which works offline. Words follow [GLOSSARY.md](../GLOSSARY.md); the developer contract is [development.md](development.md).

## Starting

ClearCase runs on your computer and needs no network. From the `clearcase/` checkout, with Bun 1.4.2:

```sh
bun install --frozen-lockfile
bun run --bun build
bun run --bun start
```

`start` prints two addresses, both on 127.0.0.1: the app (port 41101 by default) and the originals site that shows the PDFs (the next port). Open the app's address in a browser. Your data lives in one data directory (`CLEARCASE_DATA_DIR`, by default `~/.local/share/clearcase`): the imported results, your work and its automatic copies. Only one ClearCase can use a data directory at a time.

## Importing a case

Choose Import, type the path of the case folder (the originals) and of the results package that processing produced from it, then Validate package. The validation report checks the package and every original before anything is shown. Preview shows the candidate read-only; Activate makes it the case's active results version after you acknowledge any new warning. Importing a newer package makes a new results version; the previous one stays available, and the Overview can return to it.

Refs name each document: the prefix is its bundle (for example OD- original discovery, SD- supplementary discovery, EM- correspondence, PN- pleadings), the number its place in the bundle.

## What search covers

Search finds words only in documents that have extracted text. A document without text, usually a scanned image that still needs OCR, or one whose text is pending, is found only by its ref, filename and other metadata. The Manual counts both kinds and lists the scanned documents that need OCR. A file found by a rescan has no extracted text until a new results package includes it.

## Keeping the case folder in step: Rescan & Update

The Overview's Freshness card says when the results were built, how many documents are indexed, how many a rescan has added, and when the folder was last scanned. When files are added to, changed in or removed from the case folder, open System → Rescan & Update:

- **Rescan now** (quick) compares each file's relative path, size and date with the originals the results version indexed. It cannot see a change that keeps a file's size, so it never says the analysis is current.
- **Full scan** also reads every file and compares its SHA-256. Only a full scan that finds no difference says the folder matches the analysis.
- A new file becomes an addition with a ref that continues its bundle's numbering. It is listed in every document view as "not yet indexed". Scanning again finds the same addition and keeps its ref; refs are never reused, even after **Clear rescan additions**.
- Changed and removed originals are listed by ref. Their analysis still describes the files as they were at import.
- No scan changes the analysis. To analyse new or changed files, process the case folder again and import the new package.
- **Write updated index to file** saves the additions as v5's `ess_dcs_rescan_v1.json`.

## Backing up your work: Backup / Restore

Notes and every register you fill in are saved on this computer as you work, per case. System → Backup / Restore saves all of the active case's work to one JSON file:

- **What is in it:** every table of saved work for this case (notes, registers, rescan additions, and any table a later version adds), the case's identity (case id, name, results version), the backup format version and a checksum.
- **What is not:** binaries. The originals, the results package and the imported results are not in the file, and the page and the file both say so. Keep the case folder and the package as well. Accepted warnings are not carried either: a restore never accepts a warning for you.

**Import state** restores a backup into the active case. Choose the file, or type its full path on this computer (the largest backup this version restores is 64 MiB), and confirm. Before changing anything the restore checks the whole file: its size, that it is JSON, its format version, its checksum, and that every row belongs to this case. A damaged, altered, newer-format or other-case file is refused with its reason, and nothing is changed. A valid file replaces only this case's work; other cases are left as they are. Before replacing anything ClearCase copies this case's current work to a backup file in `backups/pre-restore/` of the data directory, and the page shows that file's path. Later saves never remove it, and Import state can restore it. If the copy fails, the restore is refused and nothing is changed. A restore replaces this case's work with the backup's, so work added since the backup is gone from the case, even when the backup holds no rows for it; the copy is how you get it back.

To move a case to another computer, import the same case folder and package there first, then restore the backup into it. A backup made on another results version of the same case restores too: notes keep their anchors and show as detached where a document is not in this version.

A v5 browser backup (`ess_dcs_backup.json`) is recognised and each of its stores is listed with what happened to it. Importing v5 browser state is not available in this version, so nothing is changed.

## Checking links to originals

The Manual's **Verify link sample** checks each link in the package's sample against the case folder now and says how many were found. Every original was checked at import, and a document page checks its original again when it opens.

## Budgets

Measured on the synthetic fixture under Bun (`tests/system/budgets.json`, set before the code was written): backup within 2 s and 200 MiB, restore within 4 s and 300 MiB, a full scan within 3 s, and an unchanged quick scan no slower than 1.25 times its recorded median.
