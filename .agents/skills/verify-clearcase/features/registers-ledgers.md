# Registers: ledgers

Six of the GRS-17 registers are flat ledgers of user-entered rows, kept per case in `work.sqlite` (`register_row`, one store each) and never mixed with imported results: Disbursements (`disbursements`), Timesheet (`timesheet`), Privilege Log (`privilege`), POPIA Register (`popia`), Annotations (`annotations`) and Transcripts (`transcripts`). Each page has v5's form, Add, a per-row Edit and Delete, and Export CSV. The Deadlines register is in [registers-deadlines.md](registers-deadlines.md).

## Sub-features

- `register-add` saves the form as one row (an Add with every field empty saves nothing, silently, as in v5).
- `register-edit` loads a row into the same form (`Save`, `Cancel`) and replaces its fields, keeping its id and position.
- `register-delete` removes exactly the row it is pressed on (by row id, without confirmation, as in v5).
- `register-export` downloads `<store>.csv`: v5's field keys as the header, rows in entry order, user text neutralised against formulas.
- `register-value` (Timesheet): the Value column is money(hours × rate), `R 0.00` when either is missing.
- `register-doc-ref` (Privilege Log, Annotations): a Doc ref naming a document of the version links to its page; any other ref is shown as typed and marked as not in this results version.
- `register-failed-write`: a refused or failed save shows `#register-error` and keeps every typed value.

## How to get to it (user POV)

- Choose the register in the case navigation: `#nav-disbursements_tab`, `#nav-timesheet_tab`, `#nav-privilege_tab`, `#nav-popia_tab`, `#nav-annotations_tab`, `#nav-transcriptions_tab`.
- Open `/v/<rv>/registers/<view-id>` directly.

## Driving it with verify-clearcase

Preconditions:

- `activate` passed. Registers start empty: the package seeds none.

- **Open.** *Not yet driven* (no `lib/drive.mjs` step yet; the registers browser suite drives it). Choose `#nav-<view-id>`. `main[data-ready=<view-id>]` appears, the `[data-page-heading]` h1 (the registry label) has focus, and the table's only row is v5's empty state (for example `No disbursements recorded.`).
- **Add.** *Not yet driven* (no `lib/drive.mjs` step yet; the registers browser suite drives it). Fill `#in-<field key>` (v5 keys: `date`, `desc`, `payee`, `amount`; `fee_earner`, `activity`, `hours`, `rate`, `billed`; `ref`, `basis`; `activity`, `category`, `lawful`, `retention`; `note`; `title`, `source`, `body`) and choose `#register-save` (`Add`). Wait for one more `#register-table tbody tr[data-row-id]`.
- **Edit.** *Not yet driven* (no `lib/drive.mjs` step yet; the registers browser suite drives it). Choose `[data-edit]` in a row. The form holds the row's values, `#register-save` reads `Save` and the first field has focus. Change a field and save; the row keeps its `data-row-id`.
- **Delete.** *Not yet driven* (no `lib/drive.mjs` step yet; the registers browser suite drives it). Choose `[data-delete]` in the row.
- **Export.** *Not yet driven* (no `lib/drive.mjs` step yet; the registers browser suite drives it). Choose `#register-export`; the download is `<store>.csv`.
- **Proof.** `tests/e2e/registers/suite.mjs` scenarios SC1 to SC10 and BA-07 (`$CLEARCASE_E2E_OUT/registers/`, screenshots under `screens/`).

## Gotchas

- Rows are ordered by an explicit `seq` field, not by `created_at`: under `CLEARCASE_FIXED_NOW` every row has the same `created_at`.
- The form and the Save button are linked by `form="register-form"`; the Save button sits in the page header next to the export.
- A busy store answers after about 10 s of retries with `#register-error` ("was not saved: the store is busy"); a stopped server with "could not be reached". Neither clears the form.
- A browser drops line breaks typed into a single-line input and turns a typed CR into a space; only the textareas (`note`, `body`) keep line breaks.
- The Edit button is the app's addition (acceptance beyond v5); the parity adapters read each row without it.
