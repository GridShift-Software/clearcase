# Info Required

The information-required checklist from the package, with a done checkbox per item that the operator's work keeps (GRS-15). Checking an item strikes its text through; the status chip stays the package's.

## Sub-features

- `info-required-toggle`: the checkbox posts `?/toggle`; a register row of store `info-required` is written with the row id `info:<sha256 of the item text, 32 hex>` (`#2`, `#3` for repeated texts) and fields `{item, done, resultsVersion}`. Unchecking stores `done: false`.
- `info-required-failed-save`: a busy store (503 after the store's retries) or an unreachable server shows `#info-error` with the item and keeps the checkbox as chosen; `#info-retry` sends the same choice again.
- `info-required-detached`: flags whose item text is not in this version are counted in `#info-detached`, never moved to another item.

## How to get to it (user POV)

- Choose `Info Required` (`#nav-info_required_tab`) or open `/v/<rv>/analysis/info_required_tab`.

## Driving it with verify-clearcase

Preconditions:

- `activate` passed on the synthetic case (one item; scenario AN-08 uses the three of `analysisData` in `tests/e2e/analysis/lib.mjs`).

- **Toggle and reload.** *Not yet driven* (no `lib/drive.mjs` step yet; proved by the analysis e2e suite). Click the checkbox in `#info-table tbody tr:nth-child(1)`; wait until no `#info-table [aria-busy="true"]` is left; reload; the box is checked and `td.struck` is set.
- **Store.** *Not yet driven* (no `lib/drive.mjs` step yet; proved by the analysis e2e suite). `SELECT row_id, fields FROM register_row WHERE store = 'info-required'` on `work.sqlite` (read-only) shows one row per toggled item.
- **Failed save.** *Not yet driven* (no `lib/drive.mjs` step yet; proved by the analysis e2e suite). Hold `PRAGMA busy_timeout=0; BEGIN IMMEDIATE` on `work.sqlite` from outside the app for more than 12 s across a click: `#info-error` appears after about 10 s, no row is written; release, choose `#info-retry`, exactly one row.
- **Proof.** Until a drive step exists, the proof is `tests/e2e/analysis/suite.mjs`, scenarios AN-08, AN-FW1, AN-FW2 and AN-RS.

## Gotchas

- Use `IMMEDIATE`, not `EXCLUSIVE`, to hold the store: with a rollback journal, `EXCLUSIVE` also blocks the page's reads.
- v5 keyed its flags by array index (`ess_dcs_info_done_v1`, S-index-keys). A later import of that store maps index `i` to `itemKeys(infoRequired)[i]` of the same results version only.
