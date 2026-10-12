# Invoice Ledger

Every imported invoice in data order with its ref, invoice number, date, bundle, amount, text status and a link to its document, the exact sum of the amounts, and a CSV export of the whole ledger.

## Sub-features

- `ledger-sum` shows the exact sum of the ledger's amounts (empty amounts count as zero), rounded once.
- `ledger-table` lists every row (`#invoice-ledger`), undated rows as `—`, text status in v5's wording (`scan · none`).
- `ledger-export` downloads `invoices.csv` with v5's columns `ref,no,date,amount,bundle,text_status,url`, source values unchanged.

## How to get to it (user POV)

- Choose `Invoice Ledger` (`#nav-invoice_ledger_tab`).
- Open `/v/<rv>/quantum/invoice_ledger_tab`.

## Driving it with verify-clearcase

- **Open.** *Driven by `tests/e2e/quantum/suite.mjs`.* `main[data-ready=invoice_ledger_tab]`; the heading is the registry label `Invoice Ledger` (v5 said `Open Invoice Ledger`, S-invoice_ledger_tab-1).
- **Sum.** The `Gross invoiced (sum, unreconciled)` KPI equals the exact sum of the rows (`Q1-INVOICE-TOTALS`).
- **Export.** Choose `#export-invoices`; the Blob download is `invoices.csv` with a header and one line per row (`Q7-EXPORT-LEDGER`).

## Gotchas

- The export is built in the browser (`download()` from `$lib/components/csv`); capture the Blob anchor rather than waiting for a file on disk.
