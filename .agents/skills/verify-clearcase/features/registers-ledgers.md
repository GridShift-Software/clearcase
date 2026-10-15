# Registers: ledgers

Six of the GRS-17 registers are flat ledgers of user-entered rows, kept per case in `work.sqlite` (`register_row`, one store each) and never mixed with imported results: Disbursements (`disbursements`), Timesheet (`timesheet`), Privilege Log (`privilege`), POPIA Register (`popia`), Annotations (`annotations`) and Transcripts (`transcripts`). Each page has v5's form, Add, a per-row Edit and Delete, and Export CSV. The Deadlines register is in [registers-deadlines.md](registers-deadlines.md).

## Sub-features

- `register-add` saves the form as one row (an Add with every field empty saves nothing, silently, as in v5).
- `register-edit` loads a row into the same form (`Save`, `Cancel`) and replaces its fields, keeping its id and position.
- `register-delete` removes exactly the row it is pressed on (by row id, without confirmation, as in v5).
- `register-export` downloads `<store>.csv`: v5's field keys as the header, rows in entry order, user text neutralised against formulas.
- `register-value` (Timesheet): the Value column is hours × rate in exact cents, rounded once half-up, `R 0.00` when either is missing.
- `register-amounts` (Disbursements Amount, Timesheet Hours and Rate): integer cents or hundredths by one grammar (`src/lib/views/registers/amounts.ts`): digits, an optional `R `, groups of three by spaces or commas, `.` and at most 2 decimals; a disbursement may be negative (a credit). Decided by the product owner on 11 October 2026: `1,500` is R 1 500.00 for an amount or a rate and is refused for hours, and credits are accepted as in v5. A decimal comma, another separator, a negative hour or rate, an exponent, other text or a value past the bound is refused with a message that keeps the typed text (S-disbursements_tab-1, S-timesheet_tab-3). A stored value that does not parse is shown as typed with `[data-not-counted]` and left out of the totals.
- `register-doc-ref` (Privilege Log, Annotations): a Doc ref naming a document of the version links to its page; any other ref is shown as typed and marked as not in this results version.
- `register-failed-write`: a refused or failed save shows `#register-error` with its message, `#register-retry` (when a retry can help) and `#register-discard`, and keeps every typed value, with and without JavaScript, until that save succeeds, is retried or is discarded. Without JavaScript every row's Edit and Delete stay off while a refused save is shown, with `#register-nojs-note` (Retry or discard first), since a Delete would re-render the page without it. A save's result changes the form only while the form still holds what was submitted; otherwise the failed entry is kept with its message and `#register-restore` puts it back, and Retry only ever resubmits the failed entry. A failed delete shows `#register-delete-error` apart; neither clears the other. A confirmed discard for Delete of the edited row clears the form at once, so a failed delete never leaves the typed text looking stored.
- `register-in-flight`: while a save is in flight the form's fieldset, Cancel and every row's Edit and Delete are disabled and `#register-status` says so; a discard question open when the save starts is closed, and only leaving the page can be answered until the result arrives.
- `register-guard`: Edit, Cancel, Delete of the edited row and an in-app link ask (`#register-ask`, `#register-ask-discard` / `#register-ask-keep`) before unsaved input is discarded.
- `register-conflict`: an edit sends the row's `version`; a row changed elsewhere is refused (409) and one deleted elsewhere too (404), with the input kept. After a 409, `#register-rebase` ("Load the current entry and keep my changes", with JavaScript) takes the entry's current version and keeps the typed values, and the next Save replaces the entry with them; without JavaScript the path is copy, Discard, Edit, paste. A row altered on disk is marked (`tr[data-altered]`).

## How to get to it (user POV)

- Choose the register in the case navigation: `#nav-disbursements_tab`, `#nav-timesheet_tab`, `#nav-privilege_tab`, `#nav-popia_tab`, `#nav-annotations_tab`, `#nav-transcriptions_tab`.
- Open `/v/<rv>/registers/<view-id>` directly.

## Driving it with verify-clearcase

Preconditions:

- `activate` passed. Registers start empty: the package seeds none.

- **Open.** *Not yet driven* (no `lib/drive.mjs` step yet; the registers browser suite drives it). Choose `#nav-<view-id>`. `main[data-ready=<view-id>]` is in the server-rendered page; `main[data-hydrated]` marks the form interactive, the `[data-page-heading]` h1 (the registry label) has focus, and the table's only row is v5's empty state (for example `No disbursements recorded.`).
- **Add.** *Not yet driven* (no `lib/drive.mjs` step yet; the registers browser suite drives it). Fill `#in-<field key>` (v5 keys: `date`, `desc`, `payee`, `amount`; `fee_earner`, `activity`, `hours`, `rate`, `billed`; `ref`, `basis`; `activity`, `category`, `lawful`, `retention`; `note`; `title`, `source`, `body`) and choose `#register-save` (`Add`). Wait for one more `#register-table tbody tr[data-row-id]`.
- **Edit.** *Not yet driven* (no `lib/drive.mjs` step yet; the registers browser suite drives it). Choose `[data-edit]` in a row. The form holds the row's values, `#register-save` reads `Save` and the first field has focus. Change a field and save; the row keeps its `data-row-id`.
- **Delete.** *Not yet driven* (no `lib/drive.mjs` step yet; the registers browser suite drives it). Choose `[data-delete]` in the row.
- **Export.** *Not yet driven* (no `lib/drive.mjs` step yet; the registers browser suite drives it). Choose `#register-export`; the download is `<store>.csv`.
- **Proof.** `tests/e2e/registers/suite.mjs` scenarios SC1 to SC25 and BA-07 (`$CLEARCASE_E2E_OUT/registers/`, screenshots under `screens/`); SC11 runs with scripts disabled; `tests/registers/actions.test.ts` drives the actions as two tabs would.

## Gotchas

- Rows are ordered by an explicit `seq` field, not by `created_at`: under `CLEARCASE_FIXED_NOW` every row has the same `created_at`.
- The form and the Save button are linked by `form="register-form"`; the Save button sits in the page header next to the export.
- A busy store answers after about 10 s of retries with `#register-error` ("was not saved: the store is busy"); a stopped server with "could not be reached". Neither clears the form.
- Every register write of one case's store runs in one in-process queue, so a write waits behind an earlier one on a busy store.
- A form with unsaved input or a failed save holds navigation: a script that navigates away (a full load gets the browser's own leave prompt, which the CDP harness dismisses) must first press `#register-discard`, as the parity driver does after v5's synthetic amounts are refused.
- A browser drops line breaks typed into a single-line input and turns a typed CR into a space; only the textareas (`note`, `body`) keep line breaks.
- The Edit button is the app's addition (acceptance beyond v5); the parity adapters read each row without it.
