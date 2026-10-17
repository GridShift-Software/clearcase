# Implement the internal FIFO processing queue and audited operator claims

Planning snapshot, 17 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-135/implement-the-internal-fifo-processing-queue-and-audited-operator) is the execution authority.

Planning key `HA-operator-queue`. Hosted-alpha delivery plan; Backlog until the overall plan is approved.

## Outcome

Authorized operators can see, claim and track a mostly FIFO metadata queue without sharing client case storage.

## Reserved write scope

* src/lib/processing-queue/\*\*
* src/routes/admin/queue/\*\*
* tests/operator-queue/\*\*

These are initial reservations. Pin exact files and accepted upstream SHA in the coordinator brief. Shared config, lockfiles, hooks and schema changes have one writer; request a handoff rather than widening scope.

## Acceptance

- [ ] Keep shared queue entries to necessary metadata and explicitly granted links; clients retain separate files/results/user work. GA/operator content access remains assigned and audited.
- [ ] Implement claim/release, status, reasons and concurrent-claim protection; make the queue visible in an internal dashboard and avoid duplicate jobs on retried finalization.
- [ ] Missing passwords/files put work into input-needed. When the client supplies the missing input, rejoin the back with a new readyAt while preserving submittedAt; operator/service mistakes keep their priority.
- [ ] Expose client-safe submitted/input-needed/published events/status to the notification owner without leaking internal details.
- [ ] Treat 24–36 hours as the initial service goal, with fair measurement/SLA refinement later. Do not hardcode an unapproved SLA, automated processing or automatic priority penalties.

## Verification and handoff

Drive two synthetic clients, concurrent operator claims, retries, missing passwords, corrected input and service mistakes. Verify FIFO ordering/timestamps, case grants, audit and no duplicate job while real files stay in their own client stores.

Use doctor at session start and verify/receipt for checks. Return PASS/HOLD/FAIL at the exact revision, changed paths, commands/exit codes, evidence and unresolved findings. Required skipped or mocked checks do not pass. One fresh independent diff review, one bounded written-finding fix and fresh recheck; only the coordinator changes Linear. No work starts while native blockers remain open.

## Boundaries

Planning creates this issue; it does not dispatch it. RAWS/current production are read-only. Shared pools/committed fixtures use synthetic data; case material, private screenshots and secrets stay out of Git and external services. No production deployment, real external messages, destructive retention action or main merge under this planning update. Normal Opus/Sonnet roles apply; a rare Fable/Astra escalation requires a separate linked issue before dispatch and results recorded afterward.

## Final workflow alignment — 17 October 2026

Accepted in [Stress-test the complete hosted-alpha plan with final workflow scenarios](<https://linear.app/vaper/issue/GRS-136/stress-test-the-complete-hosted-alpha-plan-with-final-workflow>). These are this owner's acceptance obligations; the decision record remains there.

- [ ] Distinguish the fixed original submission from the processing job tracking it. Requested passwords/missing files are linked supplementary input to that same job; retain submitted time/history, record a new eligible ready time and rejoin the back. Service-team mistakes keep the accepted priority rule.
- [ ] Ordinary new/additional/replacement batches form new submissions. Never silently merge queued jobs or mutate the finalized submission. The claim/download/attempt manifest must pin the exact original and supplementary input used. Cancellation rights and automatic job-combining are not introduced by this decision.
