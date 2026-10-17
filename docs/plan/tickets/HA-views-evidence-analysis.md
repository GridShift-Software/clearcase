# Migrate overview, chronology, evidence and analysis views to hosted contracts

Planning snapshot, 17 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-131/migrate-overview-chronology-evidence-and-analysis-views-to-hosted) is the execution authority.

Planning key `HA-views-evidence-analysis`. Hosted-alpha delivery plan; Backlog until the overall plan is approved.

## Outcome

All 16 existing overview/chronology/evidence/analysis views load, export and save supported work using hosted contracts.

## Reserved write scope

* src/routes/v/\[vid\]/overview/\*\*
* src/routes/v/\[vid\]/chronology/\*\*
* src/routes/v/\[vid\]/analysis/\*\*
* src/routes/v/\[vid\]/evidence/\*\*
* src/routes/v/\[vid\]/search/\*\*
* src/routes/api/v/\[vid\]/chronology/\*\*
* src/lib/analysis/\*\*
* src/lib/views/evidence/\*\*
* tests/hosted-views/evidence-analysis/\*\*

These are initial reservations. Pin exact files and accepted upstream SHA in the coordinator brief. Shared config, lockfiles, hooks and schema changes have one writer; request a handoff rather than widening scope.

## Acceptance

- [ ] Migrate callers to the accepted async results, user-work, authorization and asset contracts. Preserve current view content/navigation, case wording, CSV semantics and declared parity behavior.
- [ ] Enforce server-side case/version authorization in every loader/action/export route. Reject stale writes with usable feedback and audit mutations; no direct SQLite/filesystem or unscoped global app access remains in hosted requests.
- [ ] Preserve citation/original/processed references, explicit missing/unresolved targets, keyboard focus/Back and usable mobile information access.
- [ ] Do not edit the underlying shared storage/auth/schema/hooks or dependency files. Request a serialized handoff when a contract is insufficient; report all missed callers rather than adding a parallel adapter.
- [ ] Cover overview, chronology, matter, timeline, contradictions_tab, risk_matrix_tab, vdm_matrix_tab, info_required_tab, witness_tab, documents, contracts_tab, filings_tab, search, people, entity_ledger_tab and hoa_diff_tab. Include filings/info-required actions, search CSV and overview widgets.
- [ ] After acceptance, hand the info-required draft action to the email-draft owner; do not implement live Outlook integration.

## Verification and handoff

Drive every listed view with planted datasets plus supported v5/newer/JSON inputs through the canonical package. Check read/write/export cases, wrong-client/case/version and stale writes at exact SHA. Preserve all 16 views in the final coverage matrix.

Use doctor at session start and verify/receipt for checks. Return PASS/HOLD/FAIL at the exact revision, changed paths, commands/exit codes, evidence and unresolved findings. Required skipped or mocked checks do not pass. One fresh independent diff review, one bounded written-finding fix and fresh recheck; only the coordinator changes Linear. No work starts while native blockers remain open.

## Boundaries

Planning creates this issue; it does not dispatch it. RAWS/current production are read-only. Shared pools/committed fixtures use synthetic data; case material, private screenshots and secrets stay out of Git and external services. No production deployment, real external messages, destructive retention action or main merge under this planning update. Normal Opus/Sonnet roles apply; a rare Fable/Astra escalation requires a separate linked issue before dispatch and results recorded afterward.

## Native prerequisites

* [Chart the route from the ClearCase POC to hosted alpha](<https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha>)
* [Implement hosted identity, client provisioning and durable user work](<https://linear.app/vaper/issue/GRS-36/implement-hosted-identity-client-provisioning-and-durable-user-work>)
* [Implement the protected in-app viewer shell and PDF/image readers](<https://linear.app/vaper/issue/GRS-120/implement-the-protected-in-app-viewer-shell-and-pdfimage-readers>)

## Final workflow alignment — 17 October 2026

Accepted in [Stress-test the complete hosted-alpha plan with final workflow scenarios](<https://linear.app/vaper/issue/GRS-136/stress-test-the-complete-hosted-alpha-plan-with-final-workflow>). These are this owner's acceptance obligations; the decision record remains there.

- [ ] Wait for acceptance of the first complete hosted PDF workflow before broad migration. Its owner has exclusive minimal overview write scope until an explicit handoff of overview files and accepted head; this owner then completes the full existing overview/chronology/evidence/analysis coverage, preserving all 16 views.
- [ ] Use the shared visual pending/unavailable state where results are absent or withdrawn. Keep authorized independent user work and source navigation accessible through case-level routes; do not invent results or expose withdrawn/private data.
