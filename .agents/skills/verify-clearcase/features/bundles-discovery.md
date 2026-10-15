# Discovery Schedule (bundles)

The Discovery Schedule reproduces the two imported affidavit schedules (`discovery-schedules`) with their item numbers, descriptions, dates and files. The user switches schedule, filters, selects files across both schedules, marks each file Copy or Original, downloads the uncertified cover page of the current schedule, and builds a court bundle index (print or HTML download) of the selection. Selection and marks are saved per case.

## Sub-features

- `discovery-mode` switches between the two schedules (saved; clears the filter and the only-unmatched box).
- `discovery-filter` filters by item number, description, date or file name; `Only unmatched (n)` shows items without files.
- `discovery-select` ticks files or whole items; one selection across both schedules, keyed by the file's path.
- `discovery-marks` per-file C/O buttons and `Mark Copy` / `Mark Original` for the selection.
- `discovery-cover` `Open / print cover page` and `Download cover page (uncertified)`: the cover's C/O follows the marks (C, O or C&O per item).
- `discovery-bundle` `Build court bundle ▸`: the selected files in schedule, item and file-name order; print or download the index; an incomplete selection is labelled.

## How to get to it (user POV)

- Choose `Discovery Schedule` (`#nav-discovery_tab`) in the case navigation, or open `/v/<rv>/bundles/discovery_tab`.

## Driving it with verify-clearcase

Preconditions: `activate` passed on the synthetic case of `lib/inner.mjs` (`buildCase`, 7 rows); step `every-view` has opened this view once.

- **Open.** Step `every-view` (page and heading only). `main[data-ready=discovery_tab]` (server-rendered) appears and `data-hydrated` marks the controls live; the h1 is `Discovery Schedule` and receives focus after sidebar navigation.
- **Rows.** *Not yet driven.* `#ds-list tr[data-item]` holds one row per item; `#ds-info` gives items, files linked, files not in the verified index and `uncertified`.
- **Select.** *Not yet driven.* Tick `.ds-chip input[type=checkbox]`; `#ds-count` rises; `main[data-pending="0"]` once saved. Reload: the ticks and the mode return.
- **Cover.** *Not yet driven.* `#ds-cover-dl` downloads `<file>.html` once per click, however often the schedule was switched.
- **Bundle.** *Not yet driven.* `#ds-build`, then `#ds-bundle-table`; `#ds-dlindex` downloads the index; `#ds-incomplete` names an incomplete selection; `#ds-back` returns.
- **Failure.** *Not yet driven.* With `work.sqlite` locked, `#ds-error` (role alert) shows after about 10 s and the ticks stay; `#ds-retry` saves.

## Gotchas

- A schedule file opens when its decoded path is a document of the version (its document page) or a package file on disk (the originals site, GRS-45); otherwise the chip says `not in the verified index; not served`.
- Marks are never cleared by Clear (as in v5); Clear and Empty bundle only unselect.
