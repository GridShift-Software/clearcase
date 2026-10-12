# Registers: deadlines and the overview tiles

The Deadlines register (GRS-17, store `deadlines`) lists deadlines by date with v5's countdown chip, and exports an RFC 5545 calendar. The overview's `Open deadlines` and `Unbilled time` tiles are the registers' widget slots (`deadlines`, `unbilled-time`), filled from this register and the Timesheet.

## Sub-features

- `deadline-add`: Add needs a title and a date (otherwise nothing is saved, silently, as in v5); the category keeps its last value after Add.
- `deadline-countdown`: `—`, `<n>d ago`, `today`, `in <n>d` (warning within 7 days, success beyond), from `now()`.
- `deadline-delete`: removes the row it is pressed on, by row id (S-deadlines_tab-1: v5 removed the stored row at the shown position).
- `deadline-export`: the file name from the package's view-content (`exportFileName`), else `deadlines.ics` with the fixed note beside the export; CRLF lines, TEXT escaping, 75-octet folding, `DTSTAMP` from the clock, `UID:<row id>@clearcase`, v5's `DTSTART:<date>T090000`.
- `overview-deadlines`: `Open deadlines` counts dated deadlines from today on.
- `overview-unbilled`: `Unbilled time` sums the hours of entries not billed `yes` (S-overview-1: v5 counted `no` as billed).

## How to get to it (user POV)

- Choose `Deadlines` (`#nav-deadlines_tab`); open the overview for the tiles.

## Driving it with verify-clearcase

Preconditions:

- `activate` passed, with `CLEARCASE_FIXED_NOW=2026-10-08T09:00:00Z` and `TZ=UTC` for exact countdowns.

- **Countdown.** *Not yet driven* (no `lib/drive.mjs` step yet; the registers browser suite drives it). Add `Synthetic A` … `E` on 2026-10-01, 10-07, 10-08, 10-15 and 10-16. The rows show `7d ago`, `1d ago`, `today`, `in 7d`, `in 8d` in that order.
- **Delete the shown row.** *Not yet driven* (no `lib/drive.mjs` step yet; the registers browser suite drives it). With `later` (2026-12-03) entered before `earlier` (2026-11-01), Delete on the first shown row removes `earlier`.
- **Export.** *Not yet driven* (no `lib/drive.mjs` step yet; the registers browser suite drives it). Choose `#register-export` (`Export .ics`).
- **Tiles.** *Not yet driven* (no `lib/drive.mjs` step yet; the registers browser suite drives it). Open the overview: `[data-slot=deadlines][data-slot-status=filled] .num` and `[data-slot=unbilled-time] .num`.
- **Proof.** `tests/e2e/registers/suite.mjs` SC3 and SC4; parity sweeps `register_edit`, `deadline_order` and the overview's `seeded_user_work`.

## Gotchas

- The countdown is computed on the server from local midnight, as v5 did in the browser; run the server with `TZ=UTC` to match the parity clock.
- The calendar lists every dated deadline in entry order (as v5's export did), not in the table's date order.
