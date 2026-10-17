# Implement the protected in-app viewer shell and PDF/image readers

Planning snapshot, 17 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-120/implement-the-protected-in-app-viewer-shell-and-pdfimage-readers) is the execution authority.

Planning key `HA-viewer-core`. Hosted-alpha delivery plan; Backlog until the overall plan is approved.

## Outcome

A case user opens a protected original or faithful processed rendition inside the app with reliable citations and usable desktop/mobile controls.

## Reserved write scope

* src/lib/viewers/core/\*\*
* src/lib/viewers/pdf/\*\*
* src/lib/viewers/images/\*\*
* src/routes/v/\[vid\]/doc/\[ref\]/\*\* (sole writer until Notes handoff)
* src/lib/components/OriginalOpen.svelte
* tests/viewers/core/\*\*
* docs/viewers.md

These are initial reservations. Pin exact files and accepted upstream SHA in the coordinator brief. Shared config, lockfiles, hooks and schema changes have one writer; request a handoff rather than widening scope.

## Acceptance

- [ ] Implement the selected evaluation contract and a registered per-format extension point so other format owners do not edit the shared shell.
- [ ] Preserve original/processed identities, rendition versions and exact page/location mappings. Unmatched supplied references require repair, not guessed/clamped locations.
- [ ] Provide PDF/image viewing without required download, clear original versus processed labels, keyboard/focus, zoom/find/page navigation and usable narrow-screen layout.
- [ ] Serve through the accepted authorized asset API; isolate active content and deny draft/wrong-client/case/version access. Storage owner retains integrity/range implementation.
- [ ] Expose preview-readiness/failed-preview states to import/publication. Failed required previews hold the whole update; keep previous publication accessible.

## Verification and handoff

Run selected components in real browser against Workers asset delivery on synthetic POC-sized files, including bad refs, corruption/denied access, keyboard and desktop/mobile widths. Pin exact component versions/licenses and receipts.

Use doctor at session start and verify/receipt for checks. Return PASS/HOLD/FAIL at the exact revision, changed paths, commands/exit codes, evidence and unresolved findings. Required skipped or mocked checks do not pass. One fresh independent diff review, one bounded written-finding fix and fresh recheck; only the coordinator changes Linear. No work starts while native blockers remain open.

## Boundaries

Planning creates this issue; it does not dispatch it. RAWS/current production are read-only. Shared pools/committed fixtures use synthetic data; case material, private screenshots and secrets stay out of Git and external services. No production deployment, real external messages, destructive retention action or main merge under this planning update. Normal Opus/Sonnet roles apply; a rare Fable/Astra escalation requires a separate linked issue before dispatch and results recorded afterward.

## Native prerequisites

* [Chart the route from the ClearCase POC to hosted alpha](<https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha>)
* [Implement hosted identity, client provisioning and durable user work](<https://linear.app/vaper/issue/GRS-36/implement-hosted-identity-client-provisioning-and-durable-user-work>)
* [Evaluate viewer components and freeze alpha file coverage](<https://linear.app/vaper/issue/GRS-97/evaluate-viewer-components-and-freeze-alpha-file-coverage>)

## Final workflow alignment — 17 October 2026

Accepted in [Stress-test the complete hosted-alpha plan with final workflow scenarios](<https://linear.app/vaper/issue/GRS-136/stress-test-the-complete-hosted-alpha-plan-with-final-workflow>). These are this owner's acceptance obligations; the decision record remains there.

- [ ] Add reserved write scope src/routes/cases/\[caseId\]/files/\*\* after provisioning/storage handoff for sources without a published resultsVersion. Authorized case users can open supported PDF/images where supported and retrieve acknowledged unchanged originals while processing. Clearly label manual-conversion formats Preview pending processing and offer original retrieval, possibly download temporarily.
- [ ] Keep temporary pending-preview handling distinct from publication readiness: every published file needs its required in-app preview. A pending prepublication original is not permission to retrieve private candidate-derived assets or display unreviewed results. Supply the core contract for the early hosted PDF workflow.
