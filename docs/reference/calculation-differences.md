# Calculation rules and differences from v5 (quantum views)

GRS-16 (CC-06). How the six quantum views (Quantum & Interest, Invoice Ledger, Prescription, Interest Recalculator, Payments & Net Claim, Settlement / BATNA) parse, compute, round and date their figures, and every deliberate difference from the v5 workspace. The code is `src/lib/calculations/` (pure, browser-safe) and `src/lib/views/quantum/`; the tests are `tests/calculations/` and `tests/quantum/`. Parity entries are in [`parity/register/CC-06.json`](parity/register/CC-06.json) (IDR-200 to IDR-232).

## Amounts: one grammar, integer arithmetic

| Input | Rule | v5 |
| --- | --- | --- |
| Typed amount (payment, capital, claim, enforcement cost) | `parseAmount`: optional `R` and one optional space, digits with one kind of separator (space or comma) only between groups of three, optional `.` and one or two decimals. `R 1 000.00` (the app's own output), `R1,000`, `1 000`, `1000.5` parse. At most 13 digits of rand, so every value in cents is a safe integer. | `parseFloat`: stops at the first space or comma (`1 000` is 1, `R 500` is 0). |
| Anything else | A visible error beside the field; the typed text stays. A comma decimal (`1 000,50`) is refused as ambiguous, with its own message. A negative, a sign, a currency word, mixed separators, more than two decimals or text are refused. An empty capital in the Interest Recalculator is zero, as in v5 ("enter a capital figure"); an empty payment amount is refused (v5 ignored the click). | Text was accepted (`parseFloat(...)||0`), and Payments stored it. |
| Rate, probability, years, discount rate | `parseDecimal`: digits with an optional `.` and up to six decimals, no sign, no separators; kept as an exact fraction. Each has a range, shown beside its field and refused visibly beyond it (CC-06 r2, D6, D11): rate 0 to 100 % a year, probability 0 to 100, years 0 to 100, discount rate 0 to 100 % a year. | `parseFloat(...)||0`; v5's `calcSettle` clamps only its optimistic and pessimistic probabilities, so p = 150 gave a base above the claim. |
| Imported amount (`records.ts` `Amount`: optional minus, up to 15 digits, up to 4 decimals) | `importedUnits`: exact, in ten-thousandths of a rand. An empty value is "no value" (shown empty) and counts as zero in sums, as v5's `parseFloat(...)||0`. | `parseFloat`. |

**Exact arithmetic.** Sums (the invoice ledger total, payments), differences (the net claim, the "vs extracted Amount Due" line) and simple interest are computed on BigInt integers. A result is rounded **once**, exact half-up (half away from zero for negatives), to cents (`divRound`, `unitsToCents`), and only then passed to the shared `fmtR`/`money` as a 2-dp string, for formatting. No unrounded float ever reaches `fmtR` (which rounds with `toFixed(2)`).

**Why exact half-up.** On the sample every amount has two decimals, so the result equals v5's. A 4-decimal import differs: `1.005` is R 1.01 here, where `(1.005).toFixed(2)` gives `1.00` because the double is just below the half (`tests/calculations/money.test.ts`). Imported amounts are displayed through the same rule, so a 4-decimal value is rounded correctly, never silently changed in the data.

**Display cap (CC-06 r2, D5, D6).** No computed figure beyond R 9 999 999 999 999.99 (13 digits of rand, `MAX_SHOWN_CENTS`) is shown, in either sign: capital, interest, total, the comparison with the imported amount due, the three settlement scenarios, the floor and the costs. A result above it, or one too large to compute (a compound total that overflows or reaches 1e21, where `toFixed` gives exponent form; `floatToCents` returns null), is a visible error naming the cause, with every input kept and no figure; never an HTTP 500 or a blank. Typed amounts take at most 13 digits of rand and 2 decimals, said beside each amount field; more gets a message naming the limit, never rounding. A grouped amount whose first group starts with 0 (`0,500`, `01,000`, `0 500`) is refused as ambiguous (D20); whether a comma is a decimal or a thousands separator is a product-owner question.

**Formatting limit.** `fmtR` parses its 2-dp string back into a double. Up to 15 significant digits (13 digits of rand plus cents) round-trip exactly; a larger imported amount could be displayed with float error. The sample's largest figure has 12 significant digits.

## Interest

| Rule | Detail |
| --- | --- |
| Day-count basis | v5's Actual/365.25, unchanged: a period of `days` calendar days is `days/365.25` years (`days * 4 / 1461`). The expected examples `interest-simple` and `interest-compound` give v5's figures (R 10 020.53 and R 10 493.90). |
| Day count | Calendar days between two ISO dates with a year from 1000 to 9999, counted by arithmetic on the proleptic Gregorian calendar (`daysBetween`; CC-06 r2, D7), so no time zone or daylight saving enters it. v5 subtracted local-time dates, which is fractional across a daylight-saving change (S-interest_calc_tab-4); at `TZ=UTC` the two agree. A year outside 1000 to 9999 (for example `0024`, which `Date.UTC` read as 1924) is refused visibly, naming the field, the text and the range; nothing is computed. A determinism fix, not a basis change. |
| Simple interest | `P · r · days / (100 · 365.25)` as an exact fraction, rounded once to cents; total = capital + interest. |
| Compound (monthly) | v5's formula, `P · (1 + r/100/12)^(12 · days/365.25)`, with v5's operation order, evaluated once with `Math.pow` on doubles in one shared function (`compoundTotal`). The total is rounded once to cents from the double's value (what `Math.abs(x).toFixed(2)` computes) and interest = total − capital, so Capital + Interest = Total on screen. JavaScriptCore (Bun, server render) and V8 (Chromium) may differ in the last bit of the power; the views compare and show 2-dp strings, and the parity sweeps and the measure's numeric check found no difference on the sample. |
| Years label | v5's: the years to two decimals when positive, else `0`. |
| Reversed or invalid period | Refused visibly ("a reversed period is not computed"); nothing is computed (S-interest_calc_tab-3, IDR-213/214). v5 showed a negative interest under "0 yrs", or blanks for an invalid date. |
| Comparison line | Shown only on one basis (GRS-173; S-interest_calc_tab-5, IDR-245): the total on one capital figure, as at To with no payment deducted, against the imported amount due as at its own date. When the two dates are the same and no recorded payment is dated on or before To or undated, v5's line shows the difference. Otherwise the tile shows the amount due alone, "not comparable with your total", with no difference, and a note under the tiles says why and names each figure's basis and payment treatment (`shownOutcome`). A package with no amount due is not compared as R 0.00. The parity sweep's To date is not the sample's as-at date, so parity sees the refusal (IDR-236). |
| Payments | Not deducted by the calculator, as in v5: netting a payment needs a rule on whether it pays interest or capital first, a legal choice ClearCase does not make (the calculations are an arithmetic aid; no legal rule is certified). A recorded payment dated on or before To, or undated, stops the comparison instead (S-payments_tab-3, IDR-246). Settlement's claim prefill is net of payments (below). |

**The R100 literal.** R1,000 at 10% simple interest for a period of exactly one year is R100 (`simpleInterestYears`, `tests/calculations/interest.test.ts`). On the Actual/365.25 basis a *dated* year is not one year: 365 days give R 99.93 and 366 days R 100.21 (unit tests and e2e `Q2-R100`). The basis is kept as v5's; whether the legal basis should be 365 days is a product-owner question. In v5 a typed `1,000` parses as 1 and `R1,000` as 0; here both are R1,000.

## Settlement / BATNA

v5's model unchanged: `ev(p) = claim · p/100 / (1 + d/100)^y − cost`. The claim takes one leading minus, as v5's `parseFloat` does; when the recorded payments exceed the gross amount due, the prefilled net claim is negative and the model is computed on it as v5 computes a negative claim (CC-06 r2, D10: the settlement sweep's `negative_claim` step compares the two), with a note saying by how much the payments exceed the gross (payments minus gross, in cents, as the Payments tiles show them). An enforcement cost stays non-negative, the cost not discounted; base at `p`, optimistic at `min(100, p+15)`, pessimistic at `max(0, p−25)`; labels fixed even when clamped (S-settlement_tab-4, low, kept). Each value is one `Math.pow` evaluation on doubles, rounded once to cents. The claim and cost use the amount grammar (a claim typed `1 000 000` is the full amount: IDR-232, the separator half of S-settlement_tab-3); probability, years and rate use the decimal grammar.

## Defaults and inputs (BA-03)

| Default | Source | Absent |
| --- | --- | --- |
| Interest rate | view-content `interest_calc_tab.defaultRate` (S-interest_calc_tab-2) | empty field and a note; never a literal |
| Interest From / To | imported `interestBasis.first_invoice_date` (else `award_date`) / `headline_date`, as v5 | empty |
| Settlement probability, years, discount rate, enforcement cost | view-content `settlement_tab.defaultProbability`, `defaultYears`, `defaultDiscountRate`, `defaultEnforcementCost` (S-settlement_tab-1) | empty field and a note |
| Settlement claim | the imported `settlement.claim` **net of the payments recorded on Payments & Net Claim** (S-settlement_tab-2), in whole rand rounded half away from zero as v5's `toFixed(0)` prefill (S-settlement_tab-3 kept for the prefill); a note discloses it whenever payments exist. With no payments it equals v5. | `R 0` as v5 |

The calculator and model inputs live in the URL query (`?p=&r=&m=&from=&to=`, `?claim=&p=&y=&d=&c=`), submitted with Compute or Model (a GET form), so a reload or a shared link gives the same result; **Reset to defaults** returns to the package defaults (IDR-211, IDR-231). v5 kept no input and has no grace-period field: acceptance scenario 3 ("change and restore grace-period defaults") is read as changing and restoring the shown defaults (e2e `Q3-DEFAULTS-*`).

## Payments & Net Claim

Payments are user work in the `register_row` store `payments` (case-scoped): `date`, `amount` (as typed), `amountCents` (the grammar's integer cents), `method`, `note`, `seq` (max + 1, the insertion order; `listRows` order is not insertion order). The table and the totals use the same `amountCents` (S-payments_tab-1, high, IDR-203). A non-numeric amount is refused (S-payments_tab-2, IDR-204/205). A stored row without valid cents (only a later import of v5's `ess_dcs_payments_v1` could bring one) is shown as typed and flagged "not counted", never coerced. Net claim = imported claim − Σ cents, rounded once. Delete is by row id (v5 deleted by array index). The export keeps v5's columns `date,amount,method,note` with the typed text, neutralised against spreadsheet formulas (`userCell`).

## Quantum & Interest and Invoice Ledger

Imported figures (`headline_due`, `grossInvoiced`, `invoiceCount`) are shown as given. The ledger sum, the chart peak and every amount are exact and rounded once. When the imported gross or count disagrees with the ledger rows, a flag shows both figures (never a corrected value); on the sample they agree. The chart draws no negative bar (v5 drew a negative height, S-quantum_tab-3). Ledger, series and headline links go by ref through the document-row contract (S-quantum_tab-1: the headline now opens the document page, the two-click flow). "View charging calculations" opens the chronology with only its type filter (S-quantum_tab-2).

## Prescription (BA-01, BA-02)

The imported `prescDate` and `risk` are shown unchanged; the risk labels were classified against `interestBasis.headline_date` when the package was built (S-prescription-frozen). Two separate arithmetic figures, labelled **arithmetic only; legal rule (interruption) not approved** (IDR-224, IDR-229):

- (a) rows whose prescription date equals invoice date + 3 calendar years (`addYears`: 29 February becomes 28 February when the target year is not leap; every other day keeps its month and day). Sample: 306 of 306; 7 invoices are dated 29 February and all prescribe on 28 February (the view checklist's "no v5 row exercises it" is wrong; BA-01 is right).
- (b) rows whose prescription date is **before** the as-of date (strictly: on the as-of date itself the window is still open; PO decision, 11 October), the calendar date of `now()` in South Africa (Africa/Johannesburg: UTC+2 all year, no daylight saving, so the UTC date of the instant two hours later, whatever the host's time zone; CC-06 r2, D9; until r2 it was the UTC date, a day behind from 00:00 to 02:00 local time). 276 at 2026-10-08 under the earlier on-or-before rule (`prescription-as-of-clock`; not recounted under strictly before). An imported date with a year outside 1000 to 9999 is shown as given with the status "no valid date". Each row also shows its As-of status (IDR-225/226).

The `prescSummary` KPIs are shown as imported and flagged when they disagree with counts derived from the rows. The imported `prescSummary.note` and `interestBasis.note` render through `Narrative.svelte`, labelled "Imported narrative: not checked against the computed dates" (IDR-223, IDR-210). The filter lives in the URL (S-prescription_tab-1) and the export writes the rows shown, filtered and in order (S-prescription_tab-3, BA-17); unfiltered it equals v5.

## Time

Only `now()` (`$lib/components/clock`) is read, on the server, for three figures, each counted on the South African calendar date (`saDate`), whatever the host's time zone: the prescription as-of date, the deadline countdown on the deadline tracker, and the Overview's open-deadlines tile (IDR-289). The ICS export also reads it in the browser, for the file's `DTSTAMP` only. Under `CLEARCASE_FIXED_NOW` the views are deterministic (e2e `Q10-FIXED-CLOCK`). No other figure depends on the clock.
