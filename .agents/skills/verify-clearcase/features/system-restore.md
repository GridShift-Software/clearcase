# System: Backup / Restore

Backup / Restore saves all of one case's work (every user-work table: notes, registers, rescan additions and any table a later version adds) to one JSON file with the case identity, the results version, the format version and a checksum, and says that binaries (originals and the results package) are not included. A restore checks the whole file first: a damaged, altered, other-format or other-case file is refused with its reason and nothing changes. A valid one replaces this case's work only, after keeping a copy of the work before it. A v5 browser backup (`ess_dcs_backup.json`) is recognised and its keys listed; nothing is imported from it yet.

## Sub-features

- `backup-export` downloads `clearcase-backup-<case>-<time>.json` (`format: clearcase.backup/1`, `binaries: false`).
- `backup-tables` lists every table the backup holds now, with its owner and row count.
- `restore-file` restores an uploaded file (up to 64 MiB, checked in the page before sending).
- `restore-path` restores a file by its full path on this computer (also without JavaScript). The 64 MiB limit applies to a path as to an upload.
- `restore-refused` refuses a truncated, altered, other-format or other-case file with its reason, data unchanged.
- `restore-legacy` lists a v5 browser backup's keys, the four keys v5 never used among them, and imports the v5 custom court bundles (GRS-56) after taking a `pre-legacy-import` copy; nothing else is imported.

## How to get to it (user POV)

- `Backup / Restore` (`#nav-backup_tab`) in the case navigation, under System.
- The `Backup / Restore` link in the Manual's "Your work and backups" section.

## Driving it with verify-clearcase

Preconditions:

- `system-rescan` passed: the case has one rescan addition (`OD-005`).

- **Export.** Choose `#nav-backup_tab`; `#backup-binaries` says "Binaries are not included."; fetch `#backup-export`'s link. Step `system-backup-export`. The file has `binaries: false`, the case id and `counts.rescan_file` 1.
- **Restore.** On Rescan & Update, tick `#clear-confirm` and choose `#rescan-clear`; then on Backup / Restore fill `#restore-path` with the saved file, tick `#restore-confirm` and choose `Import state`. Step `system-restore`. `#restore-done` starts `Restored`, and Rescan & Update lists `OD-005` again.
- **Refused.** Restore the same file with another case id. Step `system-restore-refused`. `#restore-error[data-code=wrong-case]`, and Rescan & Update still lists `OD-005`.
- **Fresh profile, corrupt files, no JavaScript, in-flight typing.** *Covered in `tests/e2e/system` (SY5 to SY8).*
- **Proof.** The screenshots `system-restore-done` and `system-restore-refused`.

## Gotchas

- Uploads and paths share the 64 MiB backup limit (the route's body limit is 64 MiB plus 1 MiB), so a path is no way around it.
- A restore first takes a `pre-restore` copy (refused if that copy fails): a work.sqlite backup and a JSON backup under `backups/pre-restore/`, whose path `#restore-done` shows in `#restore-copy` and which Import state can restore.
- Accepted warnings are never carried by a backup: they belong to the results version, not to the case's work.
