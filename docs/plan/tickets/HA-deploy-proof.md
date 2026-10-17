# Prove cf and Void deployment, migration and credential boundaries

Planning snapshot, 17 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-107/prove-cf-and-void-deployment-migration-and-credential-boundaries) is the execution authority.

Planning key `HA-deploy-proof`. Hosted-alpha delivery plan; Backlog until the overall plan is approved.

## Outcome

The preferred cf/Void jobs have proven commands and a trusted per-client deployment path; demonstrated gaps have a measured Wrangler fallback.

## Reserved write scope

* tests/hosting-probe/deployment/\*\*
* deploy/probes/\*\*
* docs/acceptance/hosting/deployment.md

These are initial reservations. Pin exact files and accepted upstream SHA in the coordinator brief. Shared config, lockfiles, hooks and schema changes have one writer; request a handoff rather than widening scope.

## Acceptance

- [ ] Evaluate the published job matrix against fresh versions: dev/build/prebuilt upload, binding selection, migrations, rollback and test-pool fit. Void/cf first where capable; do not adopt their Platform SDK/ORM/auth implicitly.
- [ ] Keep app builds credential-free. A trusted parent handles reviewed config/prebuilt artifacts with a checked target manifest; prove same-account wrong-client identifiers are rejected.
- [ ] Prove migration grants/bookmarks, failure behavior and rollback. Explicitly account for Void's config evaluation and automatic D1 migrations; environment scrubbing in child processes alone is insufficient.
- [ ] Prove no account credentials in shared pools/build artifacts/logs and document actual token breadth. Do not claim unverified resource-scoped tokens exist.
- [ ] Reserve shared deploy/config writes to one future owner. Record commands and a fallback per unsupported job; catalog/source support alone is not execution evidence.

## Verification and handoff

On synthetic disposable targets, run successful and intentionally wrong-client/migration-failure paths, inspect the produced artifact and credential boundaries. Credentialed actions use separately authorized execution and secret entry. All unrun legs remain HOLD.

Use doctor at session start and verify/receipt for checks. Return PASS/HOLD/FAIL at the exact revision, changed paths, commands/exit codes, evidence and unresolved findings. Required skipped or mocked checks do not pass. One fresh independent diff review, one bounded written-finding fix and fresh recheck; only the coordinator changes Linear. No work starts while native blockers remain open.

## Boundaries

Planning creates this issue; it does not dispatch it. RAWS/current production are read-only. Shared pools/committed fixtures use synthetic data; case material, private screenshots and secrets stay out of Git and external services. No production deployment, real external messages, destructive retention action or main merge under this planning update. Normal Opus/Sonnet roles apply; a rare Fable/Astra escalation requires a separate linked issue before dispatch and results recorded afterward.

## Native prerequisites

* [Chart the route from the ClearCase POC to hosted alpha](<https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha>)
* [Gate v5, newer and JSON export compatibility](<https://linear.app/vaper/issue/GRS-24/gate-v5-newer-and-json-export-compatibility>)
* [Align agent tooling with the canonical pstack plugin and delivery controls](<https://linear.app/vaper/issue/GRS-104/align-agent-tooling-with-the-canonical-pstack-plugin-and-delivery>)
* [Prove SvelteKit 3 and Bun builds on the Cloudflare Workers runtime](<https://linear.app/vaper/issue/GRS-106/prove-sveltekit-3-and-bun-builds-on-the-cloudflare-workers-runtime>)
