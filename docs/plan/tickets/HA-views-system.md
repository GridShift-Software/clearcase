# Adapt system help and Rescan & Update for hosted processing

Planning snapshot, 16 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-134/adapt-system-help-and-rescan-and-update-for-hosted-processing) is the execution authority.

Planning key `HA-views-system`. Hosted-alpha delivery plan; Backlog until the overall plan is approved.

## Outcome

The two remaining system views describe and expose the approved hosted update workflow without server-folder access.

## Reserved write scope

* src/routes/v/\[vid\]/system/rescan_tab/\*\*
* src/routes/v/\[vid\]/system/manual/\*\*
* src/lib/views/system/rescan.server.ts
* src/lib/views/system/manual.server.ts
* src/lib/views/system/freshness.ts
* src/lib/local-case/rescan/\*\*
* src/lib/views/system/overview-widgets.server.ts (serial handoff)
* tests/hosted-views/system/\*\*

These are initial reservations. Pin exact files and accepted upstream SHA in the coordinator brief. Shared config, lockfiles, hooks and schema changes have one writer; request a handoff rather than widening scope.

## Acceptance

- [ ] Cover rescan_tab and manual. backup_tab and whole-case export are owned by the accepted recovery ticket; do not duplicate that scope.
- [ ] Remove hosted server-folder scanning/absolute-path assumptions and stale offline/local-browser wording. Keep the original navigation and show accurate submission/results freshness.
- [ ] Use the accepted Rescan & Update flow: show current submission/publication, let authorized case editors submit additions/replacements through the same upload → FIFO processing queue → private review → exact-version publication path, and preserve the current publication/user work. No server-folder scan or publication bypass.
- [ ] Use explicit grants and the canonical submission/publication contracts, retain readable help for the actual manual processing flow and preserve all user work.

## Verification and handoff

Drive both views from a case with pending/corrected/published updates, verify appropriate status and authorized next actions, and prove crafted filesystem paths cannot trigger hosted reads. Check exact-SHA references and mobile/keyboard access.

Use doctor at session start and verify/receipt for checks. Return PASS/HOLD/FAIL at the exact revision, changed paths, commands/exit codes, evidence and unresolved findings. Required skipped or mocked checks do not pass. One fresh independent diff review, one bounded written-finding fix and fresh recheck; only the coordinator changes Linear. No work starts while native blockers remain open.

## Boundaries

Planning creates this issue; it does not dispatch it. RAWS/current production are read-only. Shared pools/committed fixtures use synthetic data; case material, private screenshots and secrets stay out of Git and external services. No production deployment, real external messages, destructive retention action or main merge under this planning update. Normal Opus/Sonnet roles apply; a rare Fable/Astra escalation requires a separate linked issue before dispatch and results recorded afterward.

## Native prerequisites

* [Chart the route from the ClearCase POC to hosted alpha](<https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha>)
* [Implement hosted identity, client provisioning and durable user work](<https://linear.app/vaper/issue/GRS-36/implement-hosted-identity-client-provisioning-and-durable-user-work>)
* [Sign off and publish an exact results version](<https://linear.app/vaper/issue/GRS-31/sign-off-and-publish-an-exact-results-version>)
