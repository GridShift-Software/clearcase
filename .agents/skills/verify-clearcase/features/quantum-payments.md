# Payments & Net Claim

Records payments received against the imported claim and shows the gross amount due, the payments total and the net claim, with the monthly reconciliation chain of document refs. One amount grammar feeds the table and the totals; a non-numeric amount is refused visibly. Payments are user work (register store `payments`), kept across restarts, deleted by row id, exported as typed.

## Sub-features

- `payments-add` posts `#pay-form` (`?/add`: `date`, `amount`, `method`, `note`) with `#pay-add`; refusals and failed writes show `#pay-error` and keep every typed field.
- `payments-delete` deletes one row by its id (the row's `Delete` button).
- `payments-totals` shows `Gross amount due`, `Payments recorded` (with the receipt count) and `Net claim`.
- `payments-export` downloads `payments.csv` (`#export-payments`).
- `payments-recon` lists the reconciliation chain (`#recon`); refs link to document pages, an unknown ref is broken; the POD column shows only when some month has a POD ref.

## How to get to it (user POV)

- Choose `Payments & Net Claim` (`#nav-payments_tab`).
- Open `/v/<rv>/quantum/payments_tab`.

## Driving it with verify-clearcase

Preconditions: `activate` passed on the synthetic case of `lib/inner.mjs` (`buildCase`, 7 rows); step `every-view` has opened this view once.

- *Not yet driven by verify-clearcase.* *Proven instead by `tests/e2e/quantum/suite.mjs`*: a refused amount (`Q5-INVALID-PAYMENT`), a payment typed `R 1 000.50` and the net claim after a reload (`Q6-PAYMENT-RELOAD`), a busy store held across Add (`Q-BUSY-STORE`), the server stopped before Add (`Q-LOST-TRANSPORT`), SIGKILL and graceful restarts (`Q-RESTARTS`).
- Busy store: from the test process open `<dataDir>/work.sqlite` and run `PRAGMA busy_timeout=0; BEGIN IMMEDIATE` for more than 12 s; the action answers `fail(503)` after the store's retries.

## Gotchas

- The form fields are bound state: what the user typed survives any re-render until a successful add resets the form.
- Rows are ordered by their `seq` field; `listRows` order is not insertion order under a fixed clock.
- The Settlement / BATNA claim prefill is net of these payments.
