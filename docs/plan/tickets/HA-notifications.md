# Notify uploaders of publication and required input without blocking access

Planning snapshot, 16 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-129/notify-uploaders-of-publication-and-required-input-without-blocking) is the execution authority.

Planning key `HA-notifications`. Hosted-alpha delivery plan; Backlog until the overall plan is approved.

## Outcome

The uploader sees authoritative in-app status and receives a minimal publication/input-needed email with safe failure visibility.

## Reserved write scope

* src/lib/client-notifications/\*\*
* src/routes/client/notifications/\*\*
* tests/hosted-features/client-notifications/\*\*
* docs/operations/notifications.md

These are initial reservations. Pin exact files and accepted upstream SHA in the coordinator brief. Shared config, lockfiles, hooks and schema changes have one writer; request a handoff rather than widening scope.

## Acceptance

- [ ] Persist publication/input-needed events through the accepted small delivery contract; email the uploader a secure authenticated link with no case text, sensitive identifiers or attachments.
- [ ] Show submitted/publication status and input-needed guidance without exposing the private operator workflow.
- [ ] Use the proven Cloudflare provider and investigated sender defaults; development uses a sink. Keep live mailbox integrations separate.
- [ ] Bound retries and expose unresolved delivery problems to operators; tolerate documented ambiguous duplicates rather than claiming unsupported provider idempotency.
- [ ] Email failure cannot undo publication, hide files or remove access. Advanced reliability/alert tuning and a strict notification SLA are later refinements.

## Verification and handoff

Run submit→input-needed→corrected-input→publication events, sink/provider selected proof and deliberate provider failure/ambiguous outcomes. Verify correct recipient/client, durable in-app status, bounded retry and unchanged publication/asset access at exact SHA.

Use doctor at session start and verify/receipt for checks. Return PASS/HOLD/FAIL at the exact revision, changed paths, commands/exit codes, evidence and unresolved findings. Required skipped or mocked checks do not pass. One fresh independent diff review, one bounded written-finding fix and fresh recheck; only the coordinator changes Linear. No work starts while native blockers remain open.

## Boundaries

Planning creates this issue; it does not dispatch it. RAWS/current production are read-only. Shared pools/committed fixtures use synthetic data; case material, private screenshots and secrets stay out of Git and external services. No production deployment, real external messages, destructive retention action or main merge under this planning update. Normal Opus/Sonnet roles apply; a rare Fable/Astra escalation requires a separate linked issue before dispatch and results recorded afterward.

## Native prerequisites

* [Chart the route from the ClearCase POC to hosted alpha](<https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha>)
* [Sign off and publish an exact results version](<https://linear.app/vaper/issue/GRS-31/sign-off-and-publish-an-exact-results-version>)
* [Notify operators and download a complete submission](<https://linear.app/vaper/issue/GRS-29/notify-operators-and-download-a-complete-submission>)
