# Unify document notes and annotations into contextual case Notes

Planning snapshot, 20 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-119/unify-document-notes-and-annotations-into-contextual-case-notes) is the execution authority.

Planning key `HA-notes`. Hosted-alpha delivery plan; Backlog until the overall plan is approved.

## Outcome

One contextual Notes feature links each record to its case, original/processed document location or analysis section with no lost records.

## Reserved write scope

* src/lib/notes/\*\*
* src/routes/v/\[vid\]/registers/annotations_tab/\*\*
* src/routes/v/\[vid\]/doc/\[ref\]/\*\* (Notes integration only; serial handoff from viewer core)
* src/lib/components/Notes.svelte
* tests/hosted-features/notes/\*\*
* src/lib/views/registers/defs.ts (annotations only; serial handoff after register migration)

These are initial reservations. Pin exact files and accepted upstream SHA in the coordinator brief. Shared config, lockfiles, hooks and schema changes have one writer; request a handoff rather than widening scope.

## Acceptance

- [ ] Consolidate existing document notes and analysis annotations without record loss; keep original/processed references distinct and unresolved targets explicit.
- [ ] Default visibility is assigned case users. Case viewers read only; authors manage their own Notes and case editors can manage others, retaining audit history.
- [ ] Show case/document/page/section context and clear shared visibility. Preserve the original navigation for alpha; do not adopt the discarded prototype navigation.
- [ ] Use hosted durable user work and audit contracts; replacement publication/rollback must not attach a note to a different original.
- [ ] Wire explicit Notes opt-in/scope to full-case and client packet exports through accepted export APIs, leaving Notes excluded by default.

## Verification and handoff

Seed both legacy record kinds, consolidate, edit/delete as author/editor/viewer and verify audit history. Test grants, stale edits, changed refs, restart, backup/restore and export opt-in through real UI/API at exact SHA.

Use doctor at session start and verify/receipt for checks. Return PASS/HOLD/FAIL at the exact revision, changed paths, commands/exit codes, evidence and unresolved findings. Required skipped or mocked checks do not pass. One fresh independent diff review, one bounded written-finding fix and fresh recheck; only the coordinator changes Linear. No work starts while native blockers remain open.

## Boundaries

Planning creates this issue; it does not dispatch it. RAWS/current production are read-only. Shared pools/committed fixtures use synthetic data; case material, private screenshots and secrets stay out of Git and external services. No production deployment, real external messages, destructive retention action or main merge under this planning update. Normal Opus/Sonnet roles apply; a rare Fable/Astra escalation requires a separate linked issue before dispatch and results recorded afterward.

## Native prerequisites

* [Chart the route from the ClearCase POC to hosted alpha](<https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha>)
* [Implement hosted identity, client provisioning and durable user work](<https://linear.app/vaper/issue/GRS-36/implement-hosted-identity-client-provisioning-and-durable-user-work>)
* [Implement the protected in-app viewer shell and PDF/image readers](<https://linear.app/vaper/issue/GRS-120/implement-the-protected-in-app-viewer-shell-and-pdfimage-readers>)
* [Migrate quantum and case registers to hosted contracts](<https://linear.app/vaper/issue/GRS-132/migrate-quantum-and-case-registers-to-hosted-contracts>)

## Final workflow alignment — 17 October 2026

Accepted in [Stress-test the complete hosted-alpha plan with final workflow scenarios](<https://linear.app/vaper/issue/GRS-136/stress-test-the-complete-hosted-alpha-plan-with-final-workflow>). These are this owner's acceptance obligations; the decision record remains there.

- [ ] Provide case-level Notes before first publication and after results withdrawal. Add reserved write scope src/routes/cases/\[caseId\]/notes/\*\* after the provisioning owner's accepted handoff, using the accepted case user-work contract. Preserve original-linked Notes and expose unavailable results context honestly; do not expose private/withdrawn analysis.
