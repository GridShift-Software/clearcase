# Migrate quantum and case registers to hosted contracts

Planning snapshot, 17 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-132/migrate-quantum-and-case-registers-to-hosted-contracts) is the execution authority.

Planning key `HA-views-quantum-registers`. Hosted-alpha delivery plan; Backlog until the overall plan is approved.

## Outcome

The 12 quantum/register views outside contextual Notes preserve their calculations, edits and exports on hosted storage.

## Reserved write scope

* src/routes/v/\[vid\]/quantum/\*\*
* src/routes/v/\[vid\]/registers/\*\* except annotations_tab
* src/lib/views/quantum/\*\*
* src/lib/views/registers/\*\*
* src/lib/user-work/registers.server.ts
* tests/hosted-views/quantum-registers/\*\*

These are initial reservations. Pin exact files and accepted upstream SHA in the coordinator brief. Shared config, lockfiles, hooks and schema changes have one writer; request a handoff rather than widening scope.

## Acceptance

- [ ] Migrate callers to the accepted async results, user-work, authorization and asset contracts. Preserve current view content/navigation, case wording, CSV semantics and declared parity behavior.
- [ ] Enforce server-side case/version authorization in every loader/action/export route. Reject stale writes with usable feedback and audit mutations; no direct SQLite/filesystem or unscoped global app access remains in hosted requests.
- [ ] Preserve citation/original/processed references, explicit missing/unresolved targets, keyboard focus/Back and usable mobile information access.
- [ ] Do not edit the underlying shared storage/auth/schema/hooks or dependency files. Request a serialized handoff when a contract is insufficient; report all missed callers rather than adding a parallel adapter.
- [ ] Cover quantum_tab, invoice_ledger_tab, prescription_tab, interest_calc_tab, payments_tab, settlement_tab, disbursements_tab, timesheet_tab, deadlines_tab, privilege_tab, popia_tab and transcriptions_tab. Contextual annotations_tab belongs to the Notes owner.
- [ ] Keep money/currency/source calculations exact, preserve register categories and eliminate inherited 'saved in this browser/computer' wording where hosted persistence now applies.
- [ ] Hand shared register definitions/overview widgets to Notes/cost/privilege owners serially after acceptance; they must not concurrently rewrite the register infrastructure.

## Verification and handoff

Drive each view's real read/edit/delete/export paths with independent expected calculations, role denials and conflicts; verify restart/replacement/rollback/backup preservation for every relevant store at exact SHA.

Use doctor at session start and verify/receipt for checks. Return PASS/HOLD/FAIL at the exact revision, changed paths, commands/exit codes, evidence and unresolved findings. Required skipped or mocked checks do not pass. One fresh independent diff review, one bounded written-finding fix and fresh recheck; only the coordinator changes Linear. No work starts while native blockers remain open.

## Boundaries

Planning creates this issue; it does not dispatch it. RAWS/current production are read-only. Shared pools/committed fixtures use synthetic data; case material, private screenshots and secrets stay out of Git and external services. No production deployment, real external messages, destructive retention action or main merge under this planning update. Normal Opus/Sonnet roles apply; a rare Fable/Astra escalation requires a separate linked issue before dispatch and results recorded afterward.

## Native prerequisites

* [Chart the route from the ClearCase POC to hosted alpha](<https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha>)
* [Implement hosted identity, client provisioning and durable user work](<https://linear.app/vaper/issue/GRS-36/implement-hosted-identity-client-provisioning-and-durable-user-work>)
* [Implement the protected in-app viewer shell and PDF/image readers](<https://linear.app/vaper/issue/GRS-120/implement-the-protected-in-app-viewer-shell-and-pdfimage-readers>)

## Final workflow alignment — 17 October 2026

Accepted in [Stress-test the complete hosted-alpha plan with final workflow scenarios](<https://linear.app/vaper/issue/GRS-136/stress-test-the-complete-hosted-alpha-plan-with-final-workflow>). These are this owner's acceptance obligations; the decision record remains there.

- [ ] Wait for acceptance of the first complete hosted PDF workflow before broad migration. Registers and result-dependent views must distinguish unavailable generated seeds/results from independent manual user work; preserve and expose the latter through case-level paths without requiring a publication. Use the shared visual state, preserving all existing coverage.
