# Implement faithful Word and Excel viewing and prepared renditions

Planning snapshot, 16 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-121/implement-faithful-word-and-excel-viewing-and-prepared-renditions) is the execution authority.

Planning key `HA-viewer-office`. Hosted-alpha delivery plan; Backlog until the overall plan is approved.

## Outcome

Accepted Word/spreadsheet files have complete in-app contents and faithful prepared renditions with explicit source mappings.

## Reserved write scope

* src/lib/viewers/office/\*\*
* tests/viewers/office/\*\*
* docs/acceptance/viewers/office.md
* Format-preparation recipe lives only in docs/acceptance/viewers/office.md. The operator-handoff owner reads/links it from docs/manual-processing.md; this issue does not write that shared document.

These are initial reservations. Pin exact files and accepted upstream SHA in the coordinator brief. Shared config, lockfiles, hooks and schema changes have one writer; request a handoff rather than widening scope.

## Acceptance

- [ ] Use selected maintained readers or manually prepared previews behind the frozen viewer extension point; do not send case files to external conversion services.
- [ ] Show spreadsheet tabs, search, exact values, hidden content and meaningful charts/formatting/comments; missing cached formula results are explicitly unavailable rather than silently calculated or dropped.
- [ ] Preserve supplied sheet/cell/range and document page/location mappings between original and processed views.
- [ ] Record exactly which legacy/current file formats are accepted and preparation required; no download-only fallback counts as accepted in-app coverage.
- [ ] Emit complete/failed preview metadata and repair diagnostics through the agreed import contract.

## Verification and handoff

Use synthetic documents/workbooks with planted hidden sheets/rows, formulas with missing values, formatting/charts/comments, large sheets and invalid references. Verify complete in-app content, original integrity, mapped locations and mobile/keyboard behavior at exact SHA.

Use doctor at session start and verify/receipt for checks. Return PASS/HOLD/FAIL at the exact revision, changed paths, commands/exit codes, evidence and unresolved findings. Required skipped or mocked checks do not pass. One fresh independent diff review, one bounded written-finding fix and fresh recheck; only the coordinator changes Linear. No work starts while native blockers remain open.

## Boundaries

Planning creates this issue; it does not dispatch it. RAWS/current production are read-only. Shared pools/committed fixtures use synthetic data; case material, private screenshots and secrets stay out of Git and external services. No production deployment, real external messages, destructive retention action or main merge under this planning update. Normal Opus/Sonnet roles apply; a rare Fable/Astra escalation requires a separate linked issue before dispatch and results recorded afterward.

## Native prerequisites

* [Chart the route from the ClearCase POC to hosted alpha](<https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha>)
* [Implement the protected in-app viewer shell and PDF/image readers](<https://linear.app/vaper/issue/GRS-120/implement-the-protected-in-app-viewer-shell-and-pdfimage-readers>)
