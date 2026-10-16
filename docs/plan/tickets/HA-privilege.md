# Require explicit privilege confirmation and disclosure scope review

Planning snapshot, 16 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-127/require-explicit-privilege-confirmation-and-disclosure-scope-review) is the execution authority.

Planning key `HA-privilege`. Hosted-alpha delivery plan; Backlog until the overall plan is approved.

## Outcome

Privilege suggestions remain suggestions until authorized confirmation, and disclosure exports show their controlled inclusion scope.

## Reserved write scope

* src/lib/privilege/\*\*
* src/routes/v/\[vid\]/privilege-suggestions/\*\*
* tests/hosted-features/privilege/\*\*
* privilege register integration only after register migration owner handoff

These are initial reservations. Pin exact files and accepted upstream SHA in the coordinator brief. Shared config, lockfiles, hooks and schema changes have one writer; request a handoff rather than widening scope.

## Acceptance

- [ ] Preserve suggestions distinctly from confirmed status; only authorized case editors can confirm/change status with audit history.
- [ ] Disclosure bundles exclude confirmed privileged documents by default, show exclusions and require an explicit case-editor override to include them.
- [ ] Expose a stable disclosure-selection API to the bundle owner and reject stale/unauthorized scope changes.
- [ ] Keep complete case backups at their agreed full scope and Notes as explicit opt-in; do not turn disclosure defaults into source-file deletion.
- [ ] Preserve original navigation and distinguish suggestions/confirmation clearly in current views.

## Verification and handoff

Test suggestion/confirmation changes, viewer/editor denials, default exclusions, explicit override and audit. Verify full-case export completeness independently from disclosure bundle filtering.

Use doctor at session start and verify/receipt for checks. Return PASS/HOLD/FAIL at the exact revision, changed paths, commands/exit codes, evidence and unresolved findings. Required skipped or mocked checks do not pass. One fresh independent diff review, one bounded written-finding fix and fresh recheck; only the coordinator changes Linear. No work starts while native blockers remain open.

## Boundaries

Planning creates this issue; it does not dispatch it. RAWS/current production are read-only. Shared pools/committed fixtures use synthetic data; case material, private screenshots and secrets stay out of Git and external services. No production deployment, real external messages, destructive retention action or main merge under this planning update. Normal Opus/Sonnet roles apply; a rare Fable/Astra escalation requires a separate linked issue before dispatch and results recorded afterward.

## Native prerequisites

* [Chart the route from the ClearCase POC to hosted alpha](<https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha>)
* [Implement hosted identity, client provisioning and durable user work](<https://linear.app/vaper/issue/GRS-36/implement-hosted-identity-client-provisioning-and-durable-user-work>)
* [Migrate quantum and case registers to hosted contracts](<https://linear.app/vaper/issue/GRS-132/migrate-quantum-and-case-registers-to-hosted-contracts>)
