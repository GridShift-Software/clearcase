# Implement accepted media and archive-contained viewing paths

Planning snapshot, 20 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-123/implement-accepted-media-and-archive-contained-viewing-paths) is the execution authority.

Planning key `HA-viewer-media-archive`. Hosted-alpha delivery plan; Backlog until the overall plan is approved.

## Outcome

Every media/archive format accepted by the frozen matrix has a safe in-app inspection path or faithful manual preview.

## Reserved write scope

* src/lib/viewers/media/\*\*
* src/lib/viewers/archive/\*\*
* tests/viewers/media-archive/\*\*
* docs/acceptance/viewers/media-archive.md

These are initial reservations. Pin exact files and accepted upstream SHA in the coordinator brief. Shared config, lockfiles, hooks and schema changes have one writer; request a handoff rather than widening scope.

## Acceptance

- [ ] Implement only coverage selected by the viewer evaluation: media playback/seeking and ZIP/container entry inspection with readable contained-file previews where accepted.
- [ ] Preserve container/entry identity, parent links, original bytes and supplied locations. Manual extraction/preparation is allowed through the reviewed processing contract.
- [ ] Reject unsafe archive paths, active content, decompression/resource limits and unsupported codecs clearly. A failed required preview holds publication rather than silently omitting contents.
- [ ] Consume existing registered format readers; do not duplicate Word/email/PDF engines or introduce a sandbox service by default.
- [ ] If evaluation finds no accepted files in a conditional category, retain the explicit matrix decision and negative-input tests; do not invent a new launch requirement.

## Verification and handoff

Use synthetic containers with nested accepted files, traversal/decompression-limit cases and accepted media codecs, exercising protected access and desktop/mobile playback/inspection at exact SHA. Document selected versus excluded formats.

Use doctor at session start and verify/receipt for checks. Return PASS/HOLD/FAIL at the exact revision, changed paths, commands/exit codes, evidence and unresolved findings. Required skipped or mocked checks do not pass. One fresh independent diff review, one bounded written-finding fix and fresh recheck; only the coordinator changes Linear. No work starts while native blockers remain open.

## Boundaries

Planning creates this issue; it does not dispatch it. RAWS/current production are read-only. Shared pools/committed fixtures use synthetic data; case material, private screenshots and secrets stay out of Git and external services. No production deployment, real external messages, destructive retention action or main merge under this planning update. Normal Opus/Sonnet roles apply; a rare Fable/Astra escalation requires a separate linked issue before dispatch and results recorded afterward.

## Native prerequisites

* [Chart the route from the ClearCase POC to hosted alpha](<https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha>)
* [Implement faithful Word and Excel viewing and prepared renditions](<https://linear.app/vaper/issue/GRS-121/implement-faithful-word-and-excel-viewing-and-prepared-renditions>)
* [Implement Outlook and Gmail email-file and attachment viewing](<https://linear.app/vaper/issue/GRS-122/implement-outlook-and-gmail-email-file-and-attachment-viewing>)

## Final workflow alignment — 17 October 2026

Accepted in [Stress-test the complete hosted-alpha plan with final workflow scenarios](<https://linear.app/vaper/issue/GRS-136/stress-test-the-complete-hosted-alpha-plan-with-final-workflow>). These are this owner's acceptance obligations; the decision record remains there.

- [ ] Keep this owner and all accepted media/archive coverage required for final release. It no longer blocks the PDF-only early import/workflow by itself. Files of these formats actually included in a candidate must still have all required in-app previews before publication; processing-only pending/download states never waive that rule.
