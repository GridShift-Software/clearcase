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

## Windows quick start

> **Native Windows is not supported.** ClearCase refuses to start without Linux's `/proc/self/fd`, which it uses to open an original safely (`LocalCase.startup()` in `src/lib/local-case/service.server.ts`). Windows has no equivalent, so a PowerShell install of Bun cannot reach the import. On Windows, run ClearCase inside WSL2, which is a real Linux.
>
> **Not verified end to end.** Nobody has yet run these steps on a Windows computer. Three parts are untried: reaching the app from a Windows browser through WSL2's `localhost` forwarding, opening the originals site (a `*.localhost` address) from a Windows browser, and importing a case folder from a path copied out of Windows. If a step fails, note the command and its full output, and report it with the comparison.

This is the setup for the side-by-side comparison with the production system on Windows (GRS-64). You need Windows 10 (version 2004 or later) or Windows 11, a current Chrome or Edge, and the ClearCase checkout. You also need the case folder and the results package that you receive with the case. This guide contains no case data.

1. Install WSL2 with Ubuntu. In PowerShell as administrator, run `wsl --install -d Ubuntu`, restart if it asks, and create the Linux user it prompts for. From here on, every command runs in the Ubuntu terminal, not in PowerShell.

2. In Ubuntu, install Bun 1.4.2, the exact version this project pins. If `curl` or `unzip` is missing, run `sudo apt update && sudo apt install -y curl unzip git` first.

   ```sh
   curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.2"
   ```

   Open a new Ubuntu window, then check the version. It must print `1.4.2`:

   ```sh
   bun --version
   ```

3. Put the checkout, the case folder and the results package in the WSL filesystem, under your Linux home directory (`~`), not under `/mnt/c`. Clone or copy the checkout to `~/clearcase`. The app opens each original as a single regular file and checks it again as it serves it. The `/mnt/c` drive is a Windows folder shared with Linux, and it is slow and can report files differently, so keep everything under `~`. Copy the case folder and the package there, for example to `~/cases/<case folder>` and `~/cases/<package>`. In Windows Explorer the WSL home directory is `\\wsl$\Ubuntu\home\<your user>`; you can copy files into it from there. Copying a case folder from OneDrive can fail while a file is online-only: make the folder available offline first.

4. Install the dependencies, build the app and start it from the `clearcase` folder, with a data folder inside WSL:

   ```sh
   cd ~/clearcase
   bun install --frozen-lockfile
   bun run --bun build
   export CLEARCASE_DATA_DIR=~/clearcase-data/comparison
   bun run --bun start
   ```

   Set `CLEARCASE_DATA_DIR` each time you open a new Ubuntu window, otherwise ClearCase uses `~/.local/share/clearcase`. Keep the window open while you use the app. `start` prints the app address (`http://127.0.0.1:41101` by default) and the originals address (the next port). To stop the app, press Ctrl+C in that window, or run `bun run --bun start --stop` in another Ubuntu window from the same folder.

5. Open the app address in Chrome or Edge on Windows. WSL2 forwards `localhost` to Linux, so `http://127.0.0.1:41101` should open (unverified). If it does not open, the app cannot be reached from Windows on this computer (it listens on 127.0.0.1 only): report it with the output of `wsl --version`. Import the case through the app:
   1. Choose **Import results**.
   2. In the case folder field, type the full WSL path of the case folder, for example `/home/<your user>/cases/<case folder>`. The app reads paths as Linux sees them, so a Windows path such as `D:\Cases\<case folder>` does not work.
   3. In the package field, type the full WSL path of the results package.
   4. Choose **Validate package**, and read the validation report.
   5. Accept the warnings it lists, then choose **Activate this version**.

   The overview of the case opens. The package and every original are checked during validation, so a large case can take a minute.

6. To compare with the production system, open the same view in each and compare them. Every intentional difference is listed in `docs/reference/parity/intentional-differences.json` and its `register/` folder, with the reason for each. The [CC-11 matrix](acceptance/CC-11/matrix.md) gives the view-by-view parity result on Linux.

Known limits of this setup:
- Opening an original goes to the originals site, a `*.localhost` address (`clearcase-originals.localhost` by default). Whether a Windows browser resolves it to WSL2 is unverified. If it does not, the document pages still show, but the Open and Download links for originals may fail.
- A file that Linux reports as a hard link is refused, because the app serves only single-link regular files. Copy the case folder into WSL rather than linking it.
- The automated checks (`bun run --bun gate`) need Linux network namespaces. They are for the development machine, not for this comparison.

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

A v5 browser backup (`ess_dcs_backup.json`) is recognised and each of its stores is listed with what happened to it. This version imports one v5 store, the saved court bundles (`ess_dcs_custom_bundles_v1`), as bundles `v5-<number>`; importing the same file again writes the same bundles. The other stores are listed as not imported, and a file with none of the court bundles changes nothing.

## Checking links to originals

The Manual's **Verify link sample** checks each link in the package's sample against the case folder now and says how many were found. Every original was checked at import, and a document page checks its original again when it opens.

## Budgets

Measured on the synthetic fixture under Bun (`tests/system/budgets.json`, set before the code was written): backup within 2 s and 200 MiB, restore within 4 s and 300 MiB, a full scan within 3 s, and an unchanged quick scan no slower than 1.25 times its recorded median.
