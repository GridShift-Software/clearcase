# Carry case costs, timesheets and disbursements into the hosted app

Planning snapshot, 16 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-125/carry-case-costs-timesheets-and-disbursements-into-the-hosted-app) is the execution authority.

Planning key `HA-costs`. Hosted-alpha delivery plan; Backlog until the overall plan is approved.

## Outcome

Assigned users can access the current case-cost/time/disbursement behavior through hosted durable storage.

## Reserved write scope

* src/lib/case-costs/\*\*
* src/routes/v/\[vid\]/costs/\*\*
* tests/hosted-features/case-costs/\*\*
* existing timesheet/disbursement route extensions only after the register migration owner's explicit handoff

These are initial reservations. Pin exact files and accepted upstream SHA in the coordinator brief. Shared config, lockfiles, hooks and schema changes have one writer; request a handoff rather than widening scope.

## Acceptance

- [ ] Inventory and preserve the existing case-cost behavior with concrete before/after examples; retain timesheets, fees/disbursements and relevant totals/exports.
- [ ] Prefer ZAR for the billing/cost view while preserving explicit currency semantics; do not infer new payment collection, checkout or a Pay ClearCase flow.
- [ ] Apply assigned-case viewer/editor rights, expected-version writes and audit history using foundation contracts.
- [ ] Ensure related records and totals survive replacement publication, rollback, restart and backup/restore.
- [ ] Coordinate existing register view edits serially after their hosted caller migration, keeping current navigation.

## Verification and handoff

Use planted time/fee/disbursement values and independent expected totals/export values; test stale writes, role denials, currency display and recovery through UI/direct API at exact SHA.

Use doctor at session start and verify/receipt for checks. Return PASS/HOLD/FAIL at the exact revision, changed paths, commands/exit codes, evidence and unresolved findings. Required skipped or mocked checks do not pass. One fresh independent diff review, one bounded written-finding fix and fresh recheck; only the coordinator changes Linear. No work starts while native blockers remain open.

## Boundaries

Planning creates this issue; it does not dispatch it. RAWS/current production are read-only. Shared pools/committed fixtures use synthetic data; case material, private screenshots and secrets stay out of Git and external services. No production deployment, real external messages, destructive retention action or main merge under this planning update. Normal Opus/Sonnet roles apply; a rare Fable/Astra escalation requires a separate linked issue before dispatch and results recorded afterward.

## Native prerequisites

* [Chart the route from the ClearCase POC to hosted alpha](<https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha>)
* [Implement hosted identity, client provisioning and durable user work](<https://linear.app/vaper/issue/GRS-36/implement-hosted-identity-client-provisioning-and-durable-user-work>)
* [Migrate quantum and case registers to hosted contracts](<https://linear.app/vaper/issue/GRS-132/migrate-quantum-and-case-registers-to-hosted-contracts>)
