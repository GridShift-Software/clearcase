# Preview and activation

A stored candidate can be previewed read-only with every view, then activated from its validation report. Activation requires acknowledging each warning that is new for the case, re-checks the stored bytes and originals, and switches the active version; the overview then offers a return to the previously active version.

## Sub-features

- `preview` opens the candidate's overview with a CANDIDATE PREVIEW banner; previewing never activates.
- `activate-ack` requires ticking the acknowledgement of new warnings before activation.
- `activate` switches the active version and lands on the active overview.
- `activate-refused` explains a refused activation (missing or stale acknowledgement, changed originals) with reason codes.
- `rollback` returns to the previously active version from the overview.

## How to get to it (user POV)

- From a validation report with a stored candidate, choose `Preview the candidate` (`#preview`).
- From the candidate banner of any preview page, choose `Back to its validation report`.
- On the report, tick `#ack` (shown only when there are new warnings) and choose `Activate this version` (`#activate`).
- On the active overview, choose `Return to the previously active version` (`#rollback`) when an earlier version was active.
- On the case list (`/cases`), choose `Open` on a case with only a candidate to reach its report.

## Driving it with verify-clearcase

Preconditions:

- `validation-report` passed: a stored, verified, not active candidate exists and nothing is active.

- **Preview.** Choose `#preview`. Step `preview`. The page is `/v/<rv>/overview` with `#candidate-banner` starting `CANDIDATE PREVIEW` and no `#active-banner`, and `#count-documents[data-count]` is 7. As a second view, the case list (`/cases`) still offers no active version for the case.
- **Back to the report.** Choose the banner's link `#candidate-banner a`. Step `activate`. `main[data-ready=import:<id>]` appears.
- **Acknowledge.** Tick `#ack`. Step `activate`: the checkbox is checked; the synthetic case has 5 new warnings, so it is required.
- **Activate.** Choose `#activate`. Step `activate`: the page lands on `/v/<rv>/overview` with `#active-banner` reading `verify-clearcase: active results version`. As a second view, the case list's `Open` link for the case now leads to `/v/<rv>/overview`.
- **Refused activation.** *Not yet driven.* Choose `#activate` without ticking `#ack`. `#activate-error[data-reasons]` names the reason and the active version is unchanged.
- **Rollback.** *Not yet driven.* Import and activate a second synthetic package for the same case, then choose `#rollback`. The case list's `Open` link leads to the first version again; with no earlier version left, the user lands on `/cases`.
- **Proof.** `screens/03-preview-candidate.png`, `screens/04-activation-form.png` and `screens/05-activated-overview.png`, with the case list's `Open` targets (`activeAfterPreview`, `activeVersion`) in `inner.json`.

## Gotchas

- Activation posts a plain form (no `use:enhance`): wait for the overview with `#active-banner`, up to 60 s, not for a client-side navigation.
- The acknowledgement covers the warning fingerprints rendered in the form; a report reloaded after another activation may need a new acknowledgement.
- Preview pages and active pages share routes. Tell them apart by `#candidate-banner` and `#active-banner`, not by the URL.
