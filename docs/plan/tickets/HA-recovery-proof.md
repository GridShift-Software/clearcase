# Prove recovery, deletion and retention contracts for hosted alpha

Planning snapshot, 20 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-110/prove-recovery-deletion-and-retention-contracts-for-hosted-alpha) is the execution authority.

Planning key `HA-recovery-proof`. Hosted-alpha delivery plan; Backlog until the overall plan is approved.

## Outcome

A tested recovery design preserves acknowledged originals and ordinary rollback user work while defining deletion/backup behavior.

## Reserved write scope

* tests/hosting-probe/recovery/\*\*
* docs/acceptance/hosting/recovery.md

These are initial reservations. Pin exact files and accepted upstream SHA in the coordinator brief. Shared config, lockfiles, hooks and schema changes have one writer; request a handoff rather than widening scope.

## Acceptance

- [ ] Prove acknowledged originals recover and disaster recovery loses at most one hour of recent Notes/case edits. Ordinary results rollback loses no user work.
- [ ] Separate rolling 30-day recovery copies from live case retention and bundle history; no automatic case/client purge.
- [ ] Model firm-admin deletion request, GA approval and export offer, live access removal, copy rotation within 30 days and deletion records reapplied on restore.
- [ ] Measure the four staffed-hour recovery aim as a soft initial goal, not a strict provider-outage SLA or invented launch time gate.
- [ ] Document restore scope, corruption checks and a concrete product/runbook handoff. No current live clients need a migration/cutover project.
- [ ] Added 17 October 2026 (local-first plan, <issue id="42b36cd3-282a-42ee-b4ce-e6b04374cae7" href="https://linear.app/vaper/issue/GRS-26/prove-the-hosted-architecture-and-cloudflare-deployment">GRS-26</issue>): the deletion flow (request, approval, export offer, access removal), deletion records reapplied on restore, publication rollback without lost user work, restore from an R2 copy and the corruption checks may pass on workerd with local D1 and R2. The one-hour RPO through Time Travel, 30-day rotation and the elapsed-restore observation stay cloud legs at moment M2. Time Travel is remote-only and keeps 30 days only on Paid.

## Verification and handoff

Exercise synthetic loss/corruption, backup restore, deleted-case restoration and publication rollback; verify exact object identities and user-work timestamps. Record RPO evidence and elapsed recovery observations separately from soft targets.

Use doctor at session start and verify/receipt for checks. Return PASS/HOLD/FAIL at the exact revision, changed paths, commands/exit codes, evidence and unresolved findings. Required skipped or mocked checks do not pass. One fresh independent diff review, one bounded written-finding fix and fresh recheck; only the coordinator changes Linear. No work starts while native blockers remain open.

## Boundaries

Planning creates this issue; it does not dispatch it. RAWS/current production are read-only. Shared pools/committed fixtures use synthetic data; case material, private screenshots and secrets stay out of Git and external services. No production deployment, real external messages, destructive retention action or main merge under this planning update. Normal Opus/Sonnet roles apply; a rare Fable/Astra escalation requires a separate linked issue before dispatch and results recorded afterward.

## Native prerequisites

* [Chart the route from the ClearCase POC to hosted alpha](<https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha>)
* [Prove D1 and R2 integrity, layout and POC workload performance](<https://linear.app/vaper/issue/GRS-109/prove-d1-and-r2-integrity-layout-and-poc-workload-performance>)
