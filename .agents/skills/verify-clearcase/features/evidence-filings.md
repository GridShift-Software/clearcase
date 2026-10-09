# Filings & Affidavits (evidence)

Filings shows the imported filing groups and a filing ↔ replying-affidavit register. The register shows the imported seed rows in seed order, then the user's rows in the order added. Editing or deleting an imported seed row saves a seed overlay; the seed itself stays a result, so a later results version still shows its own seed, and an overlay whose seed changed shows a note (conflict) or stays as an orphaned edit. A failed write shows an error and keeps every typed field.

## Sub-features

- `filings-groups` the imported groups, with a classification disclosure (BA-05).
- `filings-add` adds a register row (`#register-add`); an empty Filing is refused as in v5.
- `filings-edit` edits a row (`Edit` → `?edit=<key>` → `#register-save`).
- `filings-delete` deletes a row (`Delete`); a seed row is hidden by an overlay.
- `filings-export` `filings.csv` and `filing-register.csv` (user-entered cells neutralised).

## How to get to it (user POV)

- Choose `Filings & Affidavits` (`#nav-filings_tab`), or open `/v/<rv>/evidence/filings_tab`.

## Driving it with verify-clearcase

- **Open.** Choose `#nav-filings_tab`. `main[data-ready=filings_tab]`, heading focused, `#classification-status[data-verification=unverified]`.
- **Add.** Fill `#fl_filing`, `#fl_fdate`, `#fl_fparty`, `#fl_response`, `#fl_rdate`, `#fl_ref`; choose `#register-add`. A new `#filing-register tr[data-key^="row:"][data-state=user]` appears last.
- **Edit.** Choose the row's Edit; `#register-form[data-mode=edit]` holds its values; change one and choose `#register-save`. A seed row then has `data-state=edited`.
- **Failure.** With the store busy or the server stopped, `#register-error` shows and the fields keep their values.

## Gotchas

- Keys are stable ids (`seed:<seed id>` or `row:<row id>`), never positions. The first table under `#main` is the first filing group, as in v5.
- Rows are stored in `work.sqlite`: `register_row` (store `filings-register`, fields with an integer `seq`) and `seed_overlay` (dataset `filings`).
