---
status: accepted
date: 2026-10-12
---

# Approved V1 behaviour corrections

V1 is allowed to differ from v5 where v5 was wrong, unclear or unsafe, but each difference needs a recorded reason. On 12 October 2026 the user approved the following corrections (questionnaire items 3, 4, 5, 6 and 8). They are deliberate. A later change should not restore the v5 behaviour as a parity fix.

## Quantum (item 3)

Hide the POD column when it is empty. Parse formatted amounts accurately. Reject invalid amounts and interest periods whose end precedes their start. Keep calculator inputs and filters across navigation. Export the filtered prescription rows to CSV. Keep imported risk figures visibly separate from computed arithmetic.

Affects GRS-16 (PR #16).

## Registers (item 4)

Count rows with `billed=no` as unbilled. Use neutral CSV filenames. Delete the intended deadline after sorting. Write stable, escaped ICS. Link document references only on exact matches. Validate disbursement amounts, hours and rates.

Affects GRS-17 (PR #18).

## Litigation (item 5)

Mark supplied analysis as unverified. Limit conflict checks to this case and never present a result as clearance. Distinguish locally authored work from imported work. The wider conflict folding is already approved in [ADR 0001](0001-v5-parity-and-calculation-rules.md). Missing captions remain defects to fix.

Affects GRS-18 (PR #17).

## Bundles (item 6)

Mark exports as Copy or Original. Show a notice when a selection is incomplete. Produce one download per export. Embed PDF fonts and resources, and number pages visibly. Use the correct characters in the index. Keep session links working. Avoid duplicate saves and stale range links.

Missing package-file links remain required fixes under GRS-45 and are not accepted gaps.

Affects GRS-19 (PR #22) and GRS-45.

## Shared presentation (item 8)

Move focus to the page heading after navigation, and make headings match their navigation labels. Count text absence from rows, not from a separate total. Keep links working without JavaScript.

Affects every view, including GRS-14 (PR #19) and GRS-15 (PR #20).

## Consequences

Product-visible differences still go into the intentional-differences register with `approvedBy: null` until the user approves them in the PR. This record does not replace review or gates (see the [index](README.md)).
