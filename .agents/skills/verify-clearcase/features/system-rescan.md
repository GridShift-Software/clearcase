# System: Rescan & Update

Rescan & Update compares the case folder the version was imported from with the originals that version indexed. A quick scan compares paths, sizes and dates; a full scan also compares each file's SHA-256. Files the version does not hold become additions with refs that continue the case's numbering, listed in every document view as not yet indexed and counted on the overview's Freshness card; changed and removed originals are reported by ref. No scan changes the analysis, and a quick scan never says the analysis is current.

## Sub-features

- `rescan-quick` compares paths, sizes and dates and always says contents were not compared (`#rescan-status[data-current=false]`).
- `rescan-full` reads every file and finds a change that keeps the size.
- `rescan-additions` gives each new file a new ref in its folder's bundle; a repeat scan keeps the refs and adds no duplicates.
- `rescan-changed-removed` lists changed and removed originals by ref.
- `rescan-index` downloads the additions as v5's `ess_dcs_rescan_v1.json`.
- `rescan-clear` clears the additions behind a confirmation; their refs are never issued again.
- `rescan-freshness` fills the overview's `rescan-freshness` slot: the build stamp with "+k via rescan" and the last scan.

## How to get to it (user POV)

- `Rescan & Update` (`#nav-rescan_tab`) in the case navigation, under System.
- The `Rescan & Update` link on the overview's Freshness card or in its quick links.
- The `Rescan & Update` link in the Manual.

## Driving it with verify-clearcase

Preconditions:

- `activate` passed: the synthetic version (7 originals) is active.

- **Unchanged folder.** Choose `#nav-rescan_tab`, then `Rescan now` (`#rescan-now`). Step `system-rescan`. `#count-new` is 0, `#count-scanned` 7 and `#rescan-status[data-current=false]`.
- **An addition.** Write `DISCOVERY A/OD-009 Added letter.pdf` into the synthetic case folder, choose `Rescan now` twice. Step `system-rescan`. `#rescan-added tr[data-ref]` holds exactly `OD-005` after both scans.
- **Freshness card.** Choose `#nav-overview`. Step `system-freshness`. `section[data-slot=rescan-freshness][data-slot-status=filled]`, and `#freshness-stamp` ends `8 documents indexed · +1 via rescan.`
- **Same-size change and removal.** *Covered in `tests/e2e/system` (SY3).* A full scan lists the changed original as "Changed (content differs, same size)" and a removed one as "Removed from the case folder".
- **Proof.** The screenshots `system-rescan-added` and `system-freshness`, and the counts in `inner.json`.

## Gotchas

- The scan clock is the server's (`CLEARCASE_FIXED_NOW` in tests), so two scans can show the same time: wait for `#scan-busy` to come and go, not for new text.
- The bundle prefix comes from the top-level folder (the prefix most used there), not from the new file's name: `OD-009 Added letter.pdf` gets `OD-005`.
- After a server restart the additions reach the document lists once a system page or the overview has loaded (the provider registers lazily).
