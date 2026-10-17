# Persist hosted case user work with stable identities and conflict handling

Planning snapshot, 17 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-117/persist-hosted-case-user-work-with-stable-identities-and-conflict) is the execution authority.

Planning key `HA-user-work`. Hosted-alpha delivery plan; Backlog until the overall plan is approved.

## Outcome

Notes/register/case edits persist separately from results without lost concurrent writes or reassignment across results versions.

## Reserved write scope

* src/lib/user-work/hosted/\*\*
* src/lib/local-case/user-work.server.ts
* src/lib/local-case/registers.server.ts
* src/lib/local-case/answer.server.ts
* tests/hosted-foundation/user-work/\*\*
* docs/hosted-foundation/user-work.md

These are initial reservations. Pin exact files and accepted upstream SHA in the coordinator brief. Shared config, lockfiles, hooks and schema changes have one writer; request a handoff rather than widening scope.

## Acceptance

- [ ] Implement the accepted async durable contract for all existing user-work categories and case scoping, with explicit schema upgrades and expected-version/concurrency behavior.
- [ ] Reject stale writes and preserve clear failed-save guidance; no browser-local or process-local lock stands in for cross-request durability.
- [ ] Keep stable document identity distinct from reused legacy refs. Changed/removed/ambiguous targets remain explicitly unresolved across replacement publication and rollback.
- [ ] Retain the existing records during controlled import/update; no live-client migration project is required. Contextual Notes UI/consolidation belongs to its separate owner.
- [ ] Provide backup/export/restore primitives to the recovery owner and audit mutations through the accepted event API. Feature caller migration owners consume this contract without editing its implementation.

## Verification and handoff

Exercise simultaneous edits, process restart, schema upgrade, reused refs, removed/changed originals and rollback on synthetic cases. Check every named user-work category for preservation at the exact integrated revision.

Use doctor at session start and verify/receipt for checks. Return PASS/HOLD/FAIL at the exact revision, changed paths, commands/exit codes, evidence and unresolved findings. Required skipped or mocked checks do not pass. One fresh independent diff review, one bounded written-finding fix and fresh recheck; only the coordinator changes Linear. No work starts while native blockers remain open.

## Boundaries

Planning creates this issue; it does not dispatch it. RAWS/current production are read-only. Shared pools/committed fixtures use synthetic data; case material, private screenshots and secrets stay out of Git and external services. No production deployment, real external messages, destructive retention action or main merge under this planning update. Normal Opus/Sonnet roles apply; a rare Fable/Astra escalation requires a separate linked issue before dispatch and results recorded afterward.

## Native prerequisites

* [Chart the route from the ClearCase POC to hosted alpha](<https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha>)
* [Gate the hosted design before client intake implementation](<https://linear.app/vaper/issue/GRS-27/gate-the-hosted-design-before-client-intake-implementation>)
* [Implement permission-scoped audit events and audit views](<https://linear.app/vaper/issue/GRS-116/implement-permission-scoped-audit-events-and-audit-views>)

## Final workflow alignment — 17 October 2026

Accepted in [Stress-test the complete hosted-alpha plan with final workflow scenarios](<https://linear.app/vaper/issue/GRS-136/stress-test-the-complete-hosted-alpha-plan-with-final-workflow>). These are this owner's acceptance obligations; the decision record remains there.

- [ ] Persist and authorize case-level Notes, time/cost entries and other independent user work without requiring a published resultsVersion. Withdrawal of results preserves both their data and authorized case-level accessibility. Result-dependent anchors may show unavailable context without deleting or hiding the user work; existing conflict/audit/revocation rules still apply.
