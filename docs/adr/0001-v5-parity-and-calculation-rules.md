---
status: accepted
date: 2026-10-11
---

# Full v5 parity and calculation rules

V1 reproduces every function of the v5 sample. A v5 feature is never accepted as a permanent gap. If a ticket defers one, such as the Court Bundle builder, the work returns to the owning ticket and gets built. Where v5's arithmetic is ambiguous, the user chose the following rules on 11 October 2026 so that the quantum, register and litigation views compute the same answers everywhere.

- **Interest basis.** Interest uses a 365.25-day year.
- **Prescription.** Use v5's prescription arithmetic against a live as-of date that the user can change. A claim has prescribed only when `prescDate < asOf`; a prescription date equal to the as-of date is still open.
- **Credits.** Negative disbursement and payment credits are allowed.
- **Grouped numbers.** `1,500` means one thousand five hundred for amounts and rates. Hours refuse a grouped value instead of guessing.
- **Conflict names.** Conflict Check keeps the wider name folding that the user approved.

Considered option: matching v5's literal behaviour on each point. The user rejected it where v5 was inconsistent or silently wrong.

## Consequences

- Each rule needs a test with a recorded example, and the parity report must account for any value that differs from v5 because of these rules.
- These rules settle behaviour only. Merged work still passes review and the gate at its own SHA (see the [index](README.md)).

Affects GRS-16 (PR #16), GRS-17 (PR #18), GRS-18 (PR #17) and the v5 release gate GRS-21.
