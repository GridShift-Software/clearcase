# Implement represented-client KYC review and separate compliance access

Planning snapshot, 17 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-124/implement-represented-client-kyc-review-and-separate-compliance-access) is the execution authority.

Planning key `HA-kyc`. Hosted-alpha delivery plan; Backlog until the overall plan is approved.

## Outcome

Firm admins/designated compliance users can review represented-client supporting files and history without implicit case access.

## Reserved write scope

* src/lib/kyc/\*\*
* src/routes/admin/represented-clients/\*\*
* src/routes/admin/kyc/\*\*
* tests/hosted-features/kyc/\*\*

These are initial reservations. Pin exact files and accepted upstream SHA in the coordinator brief. Shared config, lockfiles, hooks and schema changes have one writer; request a handoff rather than widening scope.

## Acceptance

- [ ] Implement manual represented-client checklist/review with separate compliance grants from case assignments.
- [ ] Incomplete KYC warns while case work/uploads remain allowed in alpha. Do not add mandatory enforcement or a verification vendor.
- [ ] Changed supporting files return the record to Needs review while preserving prior review/actor history.
- [ ] Supporting files are durable protected assets with an in-app viewing path; case viewers cannot gain compliance documents through case grants.
- [ ] Use the shared audit/storage/auth contracts and appropriate form failure/conflict behavior.

## Verification and handoff

Run independent compliance/case/firm-admin roles through checklist, file replacement/re-review and direct asset denial. Verify warnings do not block uploads, and audit/history survive restart.

Use doctor at session start and verify/receipt for checks. Return PASS/HOLD/FAIL at the exact revision, changed paths, commands/exit codes, evidence and unresolved findings. Required skipped or mocked checks do not pass. One fresh independent diff review, one bounded written-finding fix and fresh recheck; only the coordinator changes Linear. No work starts while native blockers remain open.

## Boundaries

Planning creates this issue; it does not dispatch it. RAWS/current production are read-only. Shared pools/committed fixtures use synthetic data; case material, private screenshots and secrets stay out of Git and external services. No production deployment, real external messages, destructive retention action or main merge under this planning update. Normal Opus/Sonnet roles apply; a rare Fable/Astra escalation requires a separate linked issue before dispatch and results recorded afterward.

## Native prerequisites

* [Chart the route from the ClearCase POC to hosted alpha](<https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha>)
* [Implement hosted identity, client provisioning and durable user work](<https://linear.app/vaper/issue/GRS-36/implement-hosted-identity-client-provisioning-and-durable-user-work>)
* [Implement the protected in-app viewer shell and PDF/image readers](<https://linear.app/vaper/issue/GRS-120/implement-the-protected-in-app-viewer-shell-and-pdfimage-readers>)
