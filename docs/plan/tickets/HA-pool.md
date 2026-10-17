# Prove a disposable synthetic test pool on PC2 while preserving PC1 CI

Planning snapshot, 17 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-105/prove-a-disposable-synthetic-test-pool-on-pc2-while-preserving-pc1-ci) is the execution authority.

Planning key `HA-pool`. Hosted-alpha delivery plan; Backlog until the overall plan is approved.

## Outcome

Agents can boot, test, reset and discard a credential-free environment on PC2 with reproducible receipts and measured capacity.

## Reserved write scope

* deploy/test-pool/\*\*
* scripts/test-pool/\*\*
* tests/test-pool/\*\*
* docs/test-platform.md

These are initial reservations. Pin exact files and accepted upstream SHA in the coordinator brief. Shared config, lockfiles, hooks and schema changes have one writer; request a handoff rather than widening scope.

## Acceptance

- [ ] Use the accepted PC2-first role and leave PC1's existing CI intact. Hardware/KVM observations are inputs, not proof that isolation works.
- [ ] Prefer cf/Void for jobs they can perform, with a documented fallback. Keep builds and shared pools free of production/account tokens and real case material; trusted deployment remains outside the pool.
- [ ] Prove clean boot/reset, per-job workspace/process/port separation, network policy, artifact collection and own-job cleanup after crash/timeout. No broad process killing.
- [ ] Measure one job, then bounded concurrency within the accepted three-worker/two-browser limits. Document memory/disk headroom and contention rather than declaring spare RAM sufficient.
- [ ] Document fallback to existing local verification if the pool is unavailable; local tests do not certify actual hosted bindings, isolation or recovery.

## Verification and handoff

Use synthetic jobs including intentionally failed/crashed runs and assert reset removes job state and credentials cannot be obtained. Record host/guest versions, exact image/build revision, measurements and artifacts. Any infrastructure installation needs a concrete reviewed execution step; this planning ticket itself provisions nothing.

Use doctor at session start and verify/receipt for checks. Return PASS/HOLD/FAIL at the exact revision, changed paths, commands/exit codes, evidence and unresolved findings. Required skipped or mocked checks do not pass. One fresh independent diff review, one bounded written-finding fix and fresh recheck; only the coordinator changes Linear. No work starts while native blockers remain open.

## Boundaries

Planning creates this issue; it does not dispatch it. RAWS/current production are read-only. Shared pools/committed fixtures use synthetic data; case material, private screenshots and secrets stay out of Git and external services. No production deployment, real external messages, destructive retention action or main merge under this planning update. Normal Opus/Sonnet roles apply; a rare Fable/Astra escalation requires a separate linked issue before dispatch and results recorded afterward.

## Native prerequisites

* [Chart the route from the ClearCase POC to hosted alpha](<https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha>)
* [Align agent tooling with the canonical pstack plugin and delivery controls](<https://linear.app/vaper/issue/GRS-104/align-agent-tooling-with-the-canonical-pstack-plugin-and-delivery>)

## Accepted retry, runtime and spend controls

Spend targets are reporting only; overspend is not an automatic pause/cancel/escalation trigger. Writing tasks have an initial 90-minute limit, reviews 30 minutes, and a stall assessment after 30 minutes without meaningful progress. Declare legitimate bounded long tests and per-task deadlines before dispatch; allow a short checkpoint grace, explicitly cancel an overlong/stalled job, retain work/evidence/cancellation outcome and clean up only its own resources. One transient infrastructure retry, one written-review fix round plus fresh recheck, and at most one justified rare escalation; stop the same failure twice without a new diagnosis. Renaming/restarting/redispatching cannot reset the original issue/stage attempt count.

T3 wait timeout is not a child runtime limit. Prove genuine deadline, cancellation and failed-cancellation/checkpoint paths before claiming enforcement. Recording this policy does not install a watchdog.

Use stalled/overlong synthetic jobs to prove resource cleanup, retained artifacts and refusal of an automatic respawn that resets attempts. Keep PC1 CI intact.
