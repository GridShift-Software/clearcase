# Align agent tooling with the canonical pstack plugin and delivery controls

Planning snapshot, 16 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-104/align-agent-tooling-with-the-canonical-pstack-plugin-and-delivery) is the execution authority.

Planning key `HA-tooling`. Hosted-alpha delivery plan; Backlog until the overall plan is approved.

## Outcome

A fresh shell/worktree discovers the installed canonical plugin, validates the agreed model sheet, and produces trustworthy check/cost receipts before hosted workers start.

## Reserved write scope

* scripts/agent-tools/\*\*
* tests/agent-tools/\*\*
* docs/agent-tooling.md
* proposed workspace instruction changes as a reviewable patch; active machine-wide model settings only through the later approved setup-pstack run

These are initial reservations. Pin exact files and accepted upstream SHA in the coordinator brief. Shared config, lockfiles, hooks and schema changes have one writer; request a handoff rather than widening scope.

## Acceptance

- [ ] Fix the known legacy skills-directory lookup without reinstalling upstream pstack, suppressing required failures or reopening the historically completed setup issue.
- [ ] Preserve bootstrap/doctor/verify/receipt entry points and exact revision/fingerprint binding; prove missing plugin/model, failed command and stale evidence fail clearly.
- [ ] Reconcile hosted Bun/build versus workerd runtime guidance, explicit rare Fable/Astra escalation and bounded swarm permissions; preserve external reviewer approval, serial merge rules and main protection.
- [ ] Encode the accepted escalation workflow: linked Linear issue before dispatch, bounded single-model attempt, task ID and findings/outcome/checks afterward. Do not launch an escalation as a tooling test.
- [ ] Expose actual spend where available and clearly distinguish unavailable cost, target and enforceable cap. Never claim the T3 API has a hard spend cap. Retain one-page briefs, short reports and current browser locking.

## Verification and handoff

Run doctor and positive/negative receipt/plugin-discovery tests in a fresh worktree and shell. Independently review the instruction/config candidate. Pstack's own sheet validator checks a fresh catalog; do not edit global role settings before the user's full-sheet choices.

Use doctor at session start and verify/receipt for checks. Return PASS/HOLD/FAIL at the exact revision, changed paths, commands/exit codes, evidence and unresolved findings. Required skipped or mocked checks do not pass. One fresh independent diff review, one bounded written-finding fix and fresh recheck; only the coordinator changes Linear. No work starts while native blockers remain open.

## Boundaries

Planning creates this issue; it does not dispatch it. RAWS/current production are read-only. Shared pools/committed fixtures use synthetic data; case material, private screenshots and secrets stay out of Git and external services. No production deployment, real external messages, destructive retention action or main merge under this planning update. Normal Opus/Sonnet roles apply; a rare Fable/Astra escalation requires a separate linked issue before dispatch and results recorded afterward.

## Native prerequisites

* [Chart the route from the ClearCase POC to hosted alpha](<https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha>)

## Accepted retry, runtime and spend controls

Spend targets are reporting only; overspend is not an automatic pause/cancel/escalation trigger. Writing tasks have an initial 90-minute limit, reviews 30 minutes, and a stall assessment after 30 minutes without meaningful progress. Declare legitimate bounded long tests and per-task deadlines before dispatch; allow a short checkpoint grace, explicitly cancel an overlong/stalled job, retain work/evidence/cancellation outcome and clean up only its own resources. One transient infrastructure retry, one written-review fix round plus fresh recheck, and at most one justified rare escalation; stop the same failure twice without a new diagnosis. Renaming/restarting/redispatching cannot reset the original issue/stage attempt count.

T3 wait timeout is not a child runtime limit. Prove genuine deadline, cancellation and failed-cancellation/checkpoint paths before claiming enforcement. Recording this policy does not install a watchdog.
