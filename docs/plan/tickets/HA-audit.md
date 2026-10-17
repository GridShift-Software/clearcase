# Implement permission-scoped audit events and audit views

Planning snapshot, 17 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-116/implement-permission-scoped-audit-events-and-audit-views) is the execution authority.

Planning key `HA-audit`. Hosted-alpha delivery plan; Backlog until the overall plan is approved.

## Outcome

Hosted actions write durable audit events and each user sees only the administrative, case or internal activity their grants permit.

## Reserved write scope

* src/lib/audit/\*\*
* src/routes/admin/audit/\*\*
* src/routes/v/\[vid\]/audit/\*\*
* tests/hosted-foundation/audit/\*\*
* docs/hosted-foundation/audit.md

These are initial reservations. Pin exact files and accepted upstream SHA in the coordinator brief. Shared config, lockfiles, hooks and schema changes have one writer; request a handoff rather than widening scope.

## Acceptance

- [ ] Freeze a small append/audit event contract for identity, case grants, upload/import/edit/review/publish, Notes, KYC, costs and bundle owners; feature owners instrument their own calls.
- [ ] Keep firm administration, assigned-case activity and authorized internal processing visibility separate. A firm admin/GA audit screen must not leak case content or hidden client identifiers.
- [ ] Retain actor, event, exact object/version and time with protected history. Avoid case text or secrets in operational logs.
- [ ] Prove failed/denied operations cannot be presented as successful actions and audit reads/mutations cannot cross client/case scopes.
- [ ] Cover production audit-log behavior without introducing broad analytics or a new observability vendor.

## Verification and handoff

Exercise representative successful/failed feature events and every visibility role with direct API/UI checks; verify restart durability and wrong-client denial at exact SHA. Final integration gate checks all feature owners actually emit their events.

Use doctor at session start and verify/receipt for checks. Return PASS/HOLD/FAIL at the exact revision, changed paths, commands/exit codes, evidence and unresolved findings. Required skipped or mocked checks do not pass. One fresh independent diff review, one bounded written-finding fix and fresh recheck; only the coordinator changes Linear. No work starts while native blockers remain open.

## Boundaries

Planning creates this issue; it does not dispatch it. RAWS/current production are read-only. Shared pools/committed fixtures use synthetic data; case material, private screenshots and secrets stay out of Git and external services. No production deployment, real external messages, destructive retention action or main merge under this planning update. Normal Opus/Sonnet roles apply; a rare Fable/Astra escalation requires a separate linked issue before dispatch and results recorded afterward.

## Native prerequisites

* [Chart the route from the ClearCase POC to hosted alpha](<https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha>)
* [Gate the hosted design before client intake implementation](<https://linear.app/vaper/issue/GRS-27/gate-the-hosted-design-before-client-intake-implementation>)
* [Implement hosted D1 results storage and protected R2 assets](<https://linear.app/vaper/issue/GRS-115/implement-hosted-d1-results-storage-and-protected-r2-assets>)
