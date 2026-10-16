# Edit and revalidate private results before exact-version approval

Planning snapshot, 16 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-130/edit-and-revalidate-private-results-before-exact-version-approval) is the execution authority.

Planning key `HA-preview-edit`. Hosted-alpha delivery plan; Backlog until the overall plan is approved.

## Outcome

An authorized reviewer can fix minor content/syntax errors in a private candidate while invalidating stale approvals.

## Reserved write scope

* src/lib/results-review/editor/\*\*
* src/routes/admin/results/\[candidateId\]/edit/\*\*
* tests/results-review/editing/\*\*
* shared review checklist/metadata files only after import owner handoff

These are initial reservations. Pin exact files and accepted upstream SHA in the coordinator brief. Shared config, lockfiles, hooks and schema changes have one writer; request a handoff rather than widening scope.

## Acceptance

- [ ] Allow authorized private candidate content corrections with actor/history/provenance; source originals remain unchanged.
- [ ] Every saved edit creates a fresh candidate identity, revalidates required sections/references/previews and invalidates prior approval.
- [ ] Use the same viewing behavior as the client and make errors/required-section holds clear. Retain unknown unsupported sections privately for repair.
- [ ] Preparers may approve their own candidate for alpha only through explicit recorded approval; publication still requires its explicit publisher action.
- [ ] Failed/interrupted/stale edits preserve the previous valid private candidate and the existing client publication/user work.

## Verification and handoff

Edit a synthetic candidate, introduce then repair syntax/ref/preview errors, and exercise concurrent edits and stale approvals. Prove draft asset denial and exact identity/audit changes through UI/direct requests at exact SHA.

Use doctor at session start and verify/receipt for checks. Return PASS/HOLD/FAIL at the exact revision, changed paths, commands/exit codes, evidence and unresolved findings. Required skipped or mocked checks do not pass. One fresh independent diff review, one bounded written-finding fix and fresh recheck; only the coordinator changes Linear. No work starts while native blockers remain open.

## Boundaries

Planning creates this issue; it does not dispatch it. RAWS/current production are read-only. Shared pools/committed fixtures use synthetic data; case material, private screenshots and secrets stay out of Git and external services. No production deployment, real external messages, destructive retention action or main merge under this planning update. Normal Opus/Sonnet roles apply; a rare Fable/Astra escalation requires a separate linked issue before dispatch and results recorded afterward.

## Native prerequisites

* [Chart the route from the ClearCase POC to hosted alpha](<https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha>)
* [Import processed results into a private hosted preview](<https://linear.app/vaper/issue/GRS-30/import-processed-results-into-a-private-hosted-preview>)
