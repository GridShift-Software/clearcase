# Filings & Affidavits (evidence)

Filings shows the imported filing groups and a filing ↔ replying-affidavit register. The register shows the imported seed rows in seed order, then the user's rows in the order added. Editing or deleting an imported seed row saves a seed overlay; the seed itself stays a result, so a later results version still shows its own seed, and an overlay whose seed changed shows a note (conflict) or stays as an orphaned edit. A failed write never clears or replaces typed input, with or without JavaScript: while a write is in flight the form and every row action are inert and `#register-status` says so; a refused save keeps its values, its row and `#register-error` with Retry and Discard; a refused Delete shows its own `#register-delete-error` and leaves the form and any save failure as they are. Edit, Cancel and navigation ask (`#register-ask`) before dropping a changed or refused draft.

## Sub-features

- `filings-groups` the imported groups, with a classification disclosure (BA-05).
- `filings-add` adds a register row (`#register-add`); an empty Filing is refused and one of spaces is accepted, as in v5.
- `filings-edit` edits a row (`Edit` → `?edit=<key>` → `#register-save`).
- `filings-delete` deletes a row (`[data-delete]`, a submit button of `#register-form` that also posts the form's draft); a seed row is hidden by an overlay. The edited row's Delete is inert.
- `filings-export` the filings and register exports, named by the package's view-content (`exportFileName`, `registerExportFileName`; else `filings.csv` and `filing-register.csv` with `[data-export-note]`), user-entered cells neutralised.

## How to get to it (user POV)

- Choose `Filings & Affidavits` (`#nav-filings_tab`), or open `/v/<rv>/evidence/filings_tab`.

## Driving it with verify-clearcase

- **Open.** Choose `#nav-filings_tab`. `main[data-ready=filings_tab]`, heading focused, `#classification-status[data-verification=unverified]`.
- **Add.** Fill `#fl_filing`, `#fl_fdate`, `#fl_fparty`, `#fl_response`, `#fl_rdate`, `#fl_ref`; choose `#register-add`. A new `#filing-register tr[data-key^="row:"][data-state=user]` appears last.
- **Edit.** Choose the row's Edit; `#register-form[data-mode=edit]` holds its values; change one and choose `#register-save`. A seed row then has `data-state=edited`.
- **Failure.** With the store busy (hold `BEGIN IMMEDIATE` on `<dataDir>/work.sqlite`) or the server stopped, `#register-error[data-code]` shows with `#register-retry` and `#register-discard`, and the fields and the edited row (`#register-form input[name=key]`) keep their values. A busy Delete shows `#register-delete-error` instead.
- **In flight.** `#register-status` reads `Adding the entry…`, `Saving the change…` or `Deleting the entry…`; `#register-form fieldset` and every `[data-edit]` and `[data-delete]` are disabled.
- **Without JavaScript.** A refused save re-renders in its mode with its values; while it shows, `[data-edit]` is disabled and `#register-held` says why; a Delete returns the draft and the failure with it.

## Gotchas

- Keys are stable ids (`seed:<seed id>` or `row:<row id>`), never positions. The first table under `#main` is the first filing group, as in v5.
- The harness dismisses dialogs, so a full navigation away from a changed or refused draft is blocked by the page's `beforeunload` prompt: Discard or save first.
- Rows are stored in `work.sqlite`: `register_row` (store `filings-register`, fields with an integer `seq`) and `seed_overlay` (dataset `filings`).
