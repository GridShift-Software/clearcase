# Implement complete case export, backup recovery and approved deletion

Planning snapshot, 17 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-118/implement-complete-case-export-backup-recovery-and-approved-deletion) is the execution authority.

Planning key `HA-recovery`. Hosted-alpha delivery plan; Backlog until the overall plan is approved.

## Outcome

Authorized users can export complete case assets and operators can restore protected user work while honoring approved deletions.

## Reserved write scope

* src/lib/recovery/hosted/\*\*
* src/lib/exports/case/\*\*
* src/routes/admin/recovery/\*\*
* src/routes/v/\[vid\]/system/backup_tab/\*\*
* src/lib/views/system/backup.server.ts
* tests/hosted-foundation/recovery/\*\*
* docs/operations/recovery.md
* src/lib/user-work/backup/\*\*
* src/routes/recovery/\*\*

These are initial reservations. Pin exact files and accepted upstream SHA in the coordinator brief. Shared config, lockfiles, hooks and schema changes have one writer; request a handoff rather than widening scope.

## Acceptance

- [ ] Implement 30-day rolling recovery copies separately from live case/bundle retention, preserving acknowledged originals and the accepted at-most-one-hour disaster user-work loss objective.
- [ ] Implement full case export with originals, published previews and linking manifest; contextual Notes are excluded unless explicitly selected and the chosen scope is shown before download.
- [ ] Implement firm-admin deletion request, GA approval and export offer, then approved live-case/access removal. Recovery copies rotate within 30 days and restore reapplies deletion records.
- [ ] Ordinary publication rollback preserves all user work. Restore must not revive stale assignments, deleted cases or cross-case records.
- [ ] Expose executable runbook/recovery visibility; four staffed hours is a measured soft goal. No automatic case purge, source deletion or mandatory paid recovery product.
- [ ] Replace absolute server-path restore and unfiltered store-scope export assumptions. Negative tests reject forged server paths, cross-case/global tables and revoked/deleted grants.

## Verification and handoff

Use fresh synthetic backups and intentionally damaged/missing backing stores; verify complete export bytes/manifest, opt-in Notes, recovery timestamps, all user-work categories and deleted-case suppression. Record commands and exact SHA; final gate independently reruns recovery.

Use doctor at session start and verify/receipt for checks. Return PASS/HOLD/FAIL at the exact revision, changed paths, commands/exit codes, evidence and unresolved findings. Required skipped or mocked checks do not pass. One fresh independent diff review, one bounded written-finding fix and fresh recheck; only the coordinator changes Linear. No work starts while native blockers remain open.

## Boundaries

Planning creates this issue; it does not dispatch it. RAWS/current production are read-only. Shared pools/committed fixtures use synthetic data; case material, private screenshots and secrets stay out of Git and external services. No production deployment, real external messages, destructive retention action or main merge under this planning update. Normal Opus/Sonnet roles apply; a rare Fable/Astra escalation requires a separate linked issue before dispatch and results recorded afterward.

## Native prerequisites

* [Chart the route from the ClearCase POC to hosted alpha](<https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha>)
* [Gate the hosted design before client intake implementation](<https://linear.app/vaper/issue/GRS-27/gate-the-hosted-design-before-client-intake-implementation>)
* [Persist hosted case user work with stable identities and conflict handling](<https://linear.app/vaper/issue/GRS-117/persist-hosted-case-user-work-with-stable-identities-and-conflict>)
