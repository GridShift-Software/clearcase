# Prove SvelteKit 3 and Bun builds on the Cloudflare Workers runtime

Planning snapshot, 16 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-106/prove-sveltekit-3-and-bun-builds-on-the-cloudflare-workers-runtime) is the execution authority.

Planning key `HA-runtime-proof`. Hosted-alpha delivery plan; Backlog until the overall plan is approved.

## Outcome

A minimal synthetic probe proves the chosen framework/adapter/runtime and names the actual app migration work before product changes.

## Reserved write scope

* tests/hosting-probe/runtime/\*\*
* docs/acceptance/hosting/runtime.md

These are initial reservations. Pin exact files and accepted upstream SHA in the coordinator brief. Shared config, lockfiles, hooks and schema changes have one writer; request a handoff rather than widening scope.

## Acceptance

- [ ] Pin compatible SvelteKit 3, Svelte, adapter and Bun versions from current primary sources; use supported Node helpers where vendor CLIs/Workers test hosts require them. Bun evidence and workerd evidence remain distinct.
- [ ] Exercise build, Worker request/render/action and binding access; identify actual filesystem/SQLite/process/browser-local persistence dependencies in the inherited app.
- [ ] Record upgrade/security/license decisions and unresolved advisories; a version inventory alone is not approval to ship.
- [ ] Produce an exact migration surface and numeric cold/warm staging budgets with an initial POC workload, approved by the architecture aggregator before the design gate. Probe code is not the production migration.

## Verification and handoff

Build with Bun and run the artifact under the actual Workers runtime/disposable authorized staging. Exercise representative request/action failures. Pin tool versions, exact source SHA, commands, budgets and receipts; unsupported/mocked paths stay HOLD.

Use doctor at session start and verify/receipt for checks. Return PASS/HOLD/FAIL at the exact revision, changed paths, commands/exit codes, evidence and unresolved findings. Required skipped or mocked checks do not pass. One fresh independent diff review, one bounded written-finding fix and fresh recheck; only the coordinator changes Linear. No work starts while native blockers remain open.

## Boundaries

Planning creates this issue; it does not dispatch it. RAWS/current production are read-only. Shared pools/committed fixtures use synthetic data; case material, private screenshots and secrets stay out of Git and external services. No production deployment, real external messages, destructive retention action or main merge under this planning update. Normal Opus/Sonnet roles apply; a rare Fable/Astra escalation requires a separate linked issue before dispatch and results recorded afterward.

## Native prerequisites

* [Chart the route from the ClearCase POC to hosted alpha](<https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha>)
* [Gate v5, newer and JSON export compatibility](<https://linear.app/vaper/issue/GRS-24/gate-v5-newer-and-json-export-compatibility>)
* [Align agent tooling with the canonical pstack plugin and delivery controls](<https://linear.app/vaper/issue/GRS-104/align-agent-tooling-with-the-canonical-pstack-plugin-and-delivery>)
