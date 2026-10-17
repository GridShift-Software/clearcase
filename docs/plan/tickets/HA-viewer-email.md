# Implement Outlook and Gmail email-file and attachment viewing

Planning snapshot, 17 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-122/implement-outlook-and-gmail-email-file-and-attachment-viewing) is the execution authority.

Planning key `HA-viewer-email`. Hosted-alpha delivery plan; Backlog until the overall plan is approved.

## Outcome

Exported Outlook/Gmail/provider-neutral email files and attachments can be processed and inspected inside the app.

## Reserved write scope

* src/lib/viewers/email/\*\*
* tests/viewers/email/\*\*
* docs/acceptance/viewers/email.md

These are initial reservations. Pin exact files and accepted upstream SHA in the coordinator brief. Shared config, lockfiles, hooks and schema changes have one writer; request a handoff rather than widening scope.

## Acceptance

- [ ] Support the accepted EML/MSG coverage with headers/body, inline and regular/nested attachments, message/attachment provenance and precise supplied targets.
- [ ] Preserve hostile HTML/link/content isolation, encoding and attachment identities; no active email content runs with app privileges.
- [ ] Distinguish individual files from bulk mailbox archives and follow the frozen matrix's accepted archive/manual-extraction rules. Both Outlook- and Gmail-origin synthetic samples are required.
- [ ] Use the viewer registry and protected asset API, with original/processed refs and readiness/repair metadata.
- [ ] Keep live mailbox connections, provider drafts and sync in the later integration issue; no OAuth/provider registration is inferred.

## Verification and handoff

Exercise representative synthetic Outlook/Gmail exports, multipart encodings, inline/nested attachments, invalid/missing refs and hostile markup. Verify all accepted contents are readable in-app on desktop/mobile without required download.

Use doctor at session start and verify/receipt for checks. Return PASS/HOLD/FAIL at the exact revision, changed paths, commands/exit codes, evidence and unresolved findings. Required skipped or mocked checks do not pass. One fresh independent diff review, one bounded written-finding fix and fresh recheck; only the coordinator changes Linear. No work starts while native blockers remain open.

## Boundaries

Planning creates this issue; it does not dispatch it. RAWS/current production are read-only. Shared pools/committed fixtures use synthetic data; case material, private screenshots and secrets stay out of Git and external services. No production deployment, real external messages, destructive retention action or main merge under this planning update. Normal Opus/Sonnet roles apply; a rare Fable/Astra escalation requires a separate linked issue before dispatch and results recorded afterward.

## Native prerequisites

* [Chart the route from the ClearCase POC to hosted alpha](<https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha>)
* [Implement the protected in-app viewer shell and PDF/image readers](<https://linear.app/vaper/issue/GRS-120/implement-the-protected-in-app-viewer-shell-and-pdfimage-readers>)

## Final workflow alignment — 17 October 2026

Accepted in [Stress-test the complete hosted-alpha plan with final workflow scenarios](<https://linear.app/vaper/issue/GRS-136/stress-test-the-complete-hosted-alpha-plan-with-final-workflow>). These are this owner's acceptance obligations; the decision record remains there.

- [ ] Before an email file/attachment has its required manually prepared preview, the shared shell may show Preview pending processing and offer unchanged original retrieval. This is a temporary prepublication exception only; every published email/attachment must meet the full in-app viewing contract.
