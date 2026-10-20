# Implement app-side email drafts and firm-managed templates

Planning snapshot, 20 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-126/implement-app-side-email-drafts-and-firm-managed-templates) is the execution authority.

Planning key `HA-drafts`. Hosted-alpha delivery plan; Backlog until the overall plan is approved.

## Outcome

Case editors prepare editable draft text from case information and firm templates without a live mailbox connection.

## Reserved write scope

* src/lib/email-drafts/\*\*
* src/routes/v/\[vid\]/email-draft/\*\*
* src/routes/admin/email-templates/\*\*
* tests/hosted-features/email-drafts/\*\*
* info_required_tab draft entry point after analysis migration handoff

These are initial reservations. Pin exact files and accepted upstream SHA in the coordinator brief. Shared config, lockfiles, hooks and schema changes have one writer; request a handoff rather than widening scope.

## Acceptance

- [ ] Firm admins manage shared templates; case editors adapt individual drafts without changing the shared template version.
- [ ] Preserve case context, explicit user selection and safe content rendering. Drafts are durable case user work and assigned-case scoped.
- [ ] Provide the accepted app-side draft/export/copy path without sending email or creating a mailbox draft automatically.
- [ ] Wire information-required per-row draft actions after the existing analysis caller owner stops writing the relevant paths.
- [ ] Keep live Outlook/Gmail OAuth, mailbox drafts and synchronization solely in the later integration issue.

## Verification and handoff

Create/edit a shared template and a case draft as each role, verify template isolation/version behavior, no external send, wrong-case denial and restart/recovery at exact SHA.

Use doctor at session start and verify/receipt for checks. Return PASS/HOLD/FAIL at the exact revision, changed paths, commands/exit codes, evidence and unresolved findings. Required skipped or mocked checks do not pass. One fresh independent diff review, one bounded written-finding fix and fresh recheck; only the coordinator changes Linear. No work starts while native blockers remain open.

## Boundaries

Planning creates this issue; it does not dispatch it. RAWS/current production are read-only. Shared pools/committed fixtures use synthetic data; case material, private screenshots and secrets stay out of Git and external services. No production deployment, real external messages, destructive retention action or main merge under this planning update. Normal Opus/Sonnet roles apply; a rare Fable/Astra escalation requires a separate linked issue before dispatch and results recorded afterward.

## Native prerequisites

* [Chart the route from the ClearCase POC to hosted alpha](<https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha>)
* [Implement hosted identity, client provisioning and durable user work](<https://linear.app/vaper/issue/GRS-36/implement-hosted-identity-client-provisioning-and-durable-user-work>)
* [Migrate overview, chronology, evidence and analysis views to hosted contracts](<https://linear.app/vaper/issue/GRS-131/migrate-overview-chronology-evidence-and-analysis-views-to-hosted>)
