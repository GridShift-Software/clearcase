# Migrate litigation and existing bundle workspaces to hosted contracts

Planning snapshot, 20 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-133/migrate-litigation-and-existing-bundle-workspaces-to-hosted-contracts) is the execution authority.

Planning key `HA-views-litigation-bundles`. Hosted-alpha delivery plan; Backlog until the overall plan is approved.

## Outcome

All ten litigation/bundle views work on hosted results and case user work before richer bundle persistence is added.

## Reserved write scope

* src/routes/v/\[vid\]/litigation/\*\*
* src/routes/v/\[vid\]/bundles/\*\*
* src/lib/views/litigation/\*\*
* src/lib/views/bundles/\*\*
* src/lib/bundles/\*\*
* tests/hosted-views/litigation-bundles/\*\*

These are initial reservations. Pin exact files and accepted upstream SHA in the coordinator brief. Shared config, lockfiles, hooks and schema changes have one writer; request a handoff rather than widening scope.

## Acceptance

- [ ] Migrate callers to the accepted async results, user-work, authorization and asset contracts. Preserve current view content/navigation, case wording, CSV semantics and declared parity behavior.
- [ ] Enforce server-side case/version authorization in every loader/action/export route. Reject stale writes with usable feedback and audit mutations; no direct SQLite/filesystem or unscoped global app access remains in hosted requests.
- [ ] Preserve citation/original/processed references, explicit missing/unresolved targets, keyboard focus/Back and usable mobile information access.
- [ ] Do not edit the underlying shared storage/auth/schema/hooks or dependency files. Request a serialized handoff when a contract is insufficient; report all missed callers rather than adding a parallel adapter.
- [ ] Cover conflict_tab, enforcement_tab, legality_tab, elements_tab, authorities_tab, heads_tab, crossexam_tab, discovery_tab, court_bundle_tab and caselines_tab.
- [ ] Preserve current preparation/checklist/selection behavior while clearly identifying any browser-only unsaved files until the separate durable bundle owner lands.
- [ ] After acceptance, transfer bundle paths to the durable bundle/history owner; stop writing those paths. Do not silently add privileged disclosure decisions.

## Verification and handoff

Exercise all ten views and applicable actions/exports with grants, conflicts and source ref changes. Check links to protected originals, restore of preparation work, keyboard/mobile use and exact-SHA coverage.

Use doctor at session start and verify/receipt for checks. Return PASS/HOLD/FAIL at the exact revision, changed paths, commands/exit codes, evidence and unresolved findings. Required skipped or mocked checks do not pass. One fresh independent diff review, one bounded written-finding fix and fresh recheck; only the coordinator changes Linear. No work starts while native blockers remain open.

## Boundaries

Planning creates this issue; it does not dispatch it. RAWS/current production are read-only. Shared pools/committed fixtures use synthetic data; case material, private screenshots and secrets stay out of Git and external services. No production deployment, real external messages, destructive retention action or main merge under this planning update. Normal Opus/Sonnet roles apply; a rare Fable/Astra escalation requires a separate linked issue before dispatch and results recorded afterward.

## Native prerequisites

* [Chart the route from the ClearCase POC to hosted alpha](<https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha>)
* [Implement hosted identity, client provisioning and durable user work](<https://linear.app/vaper/issue/GRS-36/implement-hosted-identity-client-provisioning-and-durable-user-work>)
* [Implement the protected in-app viewer shell and PDF/image readers](<https://linear.app/vaper/issue/GRS-120/implement-the-protected-in-app-viewer-shell-and-pdfimage-readers>)

## Final workflow alignment — 17 October 2026

Accepted in [Stress-test the complete hosted-alpha plan with final workflow scenarios](<https://linear.app/vaper/issue/GRS-136/stress-test-the-complete-hosted-alpha-plan-with-final-workflow>). These are this owner's acceptance obligations; the decision record remains there.

- [ ] Wait for acceptance of the first complete hosted PDF workflow before broad migration. When no results are published, use the shared visual unavailable/pending state for result-dependent preparation while preserving authorized independent user work and source access. Retain all existing litigation/bundle coverage and final output checks.
