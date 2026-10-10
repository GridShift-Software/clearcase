# Settlement / BATNA

v5's risk-adjusted settlement model: the claim discounted for the probability of recovery and the years to recover at a discount rate, net of enforcement cost, with pessimistic (p−25), base and optimistic (p+15) scenarios. The probability, years, discount rate and cost defaults come from view-content; the claim prefill is the imported claim net of recorded payments (disclosed when any exist). The inputs live in the URL query; `Reset to defaults` returns to the defaults.

## Sub-features

- `settlement-model` submits `#se-form` (GET: `claim`, `p`, `y`, `d`, `c`) with `#se-model`; `#se_out` shows the three KPIs, the indicative floor and the disclaimer. Without a query the model runs on the defaults.
- `settlement-validate` shows `#se-error` for a field that does not parse.
- `settlement-net` discloses a net-of-payments prefill (`#se-net`).
- `settlement-reset` (`#se-reset`).

## How to get to it (user POV)

- Choose `Settlement / BATNA` (`#nav-settlement_tab`).
- Open `/v/<rv>/quantum/settlement_tab?claim=1000000&p=70&y=2&d=10&c=100000` (the checklist example).

## Driving it with verify-clearcase

- *Driven by `tests/e2e/quantum/suite.mjs`*: change, reload and reset (`Q3-DEFAULTS-SETTLEMENT`), a comma-decimal claim refused (`Q5-INVALID-SETTLEMENT`), the net prefill after a payment (`Q6-PAYMENT-RELOAD`), a changed assumption (`Q8-SETTLEMENT`).

## Gotchas

- A missing default stays empty with `#se-missing`; the model then shows `#se-error` until the user enters it.
