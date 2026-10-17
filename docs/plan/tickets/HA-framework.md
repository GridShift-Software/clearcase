# Migrate the app build and shared server entry points to Workers

Planning snapshot, 17 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-112/migrate-the-app-build-and-shared-server-entry-points-to-workers) is the execution authority.

Planning key `HA-framework`. Hosted-alpha delivery plan; Backlog until the overall plan is approved.

## Outcome

The app builds with Bun on the accepted SvelteKit/Cloudflare stack and shared server entry points run on workerd.

## Reserved write scope

* package.json
* bun.lock
* svelte.config.\*
* vite.config.\*
* vitest.config.\*
* tsconfig.json
* src/hooks.server.ts
* src/app.d.ts
* src/routes/+layout.server.ts
* src/routes/+layout.ts
* src/lib/server/runtime/\*\*
* scripts/ci/\*\* (runtime guard only)
* docs/development.md (runtime/build sections)
* deploy/client/\*\* (one coordinated writer)
* src/routes/+layout.svelte
* src/routes/v/\[vid\]/+layout.\*
* src/routes/v/\[vid\]/\[category\]/\[view\]/\*\*
* src/app.\*
* scripts/pilot/\*\* (hosted build/entry migration only)
* src/routes/api/browse/\*\* (remove/deny local-only hosted route)

These are initial reservations. Pin exact files and accepted upstream SHA in the coordinator brief. Shared config, lockfiles, hooks and schema changes have one writer; request a handoff rather than widening scope.

## Acceptance

- [ ] Apply the independently accepted runtime/software proof; remove local listener/SQLite/filesystem assumptions from hosted entry points without shipping a second offline product.
- [ ] Add a fail-closed guard and negative test preventing local-only runtime imports in the hosted graph. Keep supported local fixture/converter tooling explicitly separated.
- [ ] Preserve safe rendering/CSP, Origin checks and error handling while replacing the loopback-only boundary with accepted hosted authorization.
- [ ] Produce a deployable credential-free artifact and reproducible local Workers start/test commands. Do not call a Node/Bun server pass hosted evidence.
- [ ] Own dependency/lockfile/shared configuration changes serially. Feature route callers and storage adapters belong to their separate owners; hand over the accepted build contract.

## Verification and handoff

Build under Bun, run workerd request/render/action smoke checks and the import-boundary negative test, then the existing required gate or its independently reviewed hosted replacement. Pin actual adapter versions and artifact SHA.

Use doctor at session start and verify/receipt for checks. Return PASS/HOLD/FAIL at the exact revision, changed paths, commands/exit codes, evidence and unresolved findings. Required skipped or mocked checks do not pass. One fresh independent diff review, one bounded written-finding fix and fresh recheck; only the coordinator changes Linear. No work starts while native blockers remain open.

## Boundaries

Planning creates this issue; it does not dispatch it. RAWS/current production are read-only. Shared pools/committed fixtures use synthetic data; case material, private screenshots and secrets stay out of Git and external services. No production deployment, real external messages, destructive retention action or main merge under this planning update. Normal Opus/Sonnet roles apply; a rare Fable/Astra escalation requires a separate linked issue before dispatch and results recorded afterward.

## Native prerequisites

* [Chart the route from the ClearCase POC to hosted alpha](<https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha>)
* [Gate the hosted design before client intake implementation](<https://linear.app/vaper/issue/GRS-27/gate-the-hosted-design-before-client-intake-implementation>)
* [Align agent tooling with the canonical pstack plugin and delivery controls](<https://linear.app/vaper/issue/GRS-104/align-agent-tooling-with-the-canonical-pstack-plugin-and-delivery>)

Concrete verification reservation: tests/hosted-foundation/runtime/\*\* owns the workerd request/render/action smoke tests and the negative hosted-import-boundary test. Use this path in the dispatch brief; no other foundation owner writes it.

## Final workflow alignment — 17 October 2026

Accepted in [Stress-test the complete hosted-alpha plan with final workflow scenarios](<https://linear.app/vaper/issue/GRS-136/stress-test-the-complete-hosted-alpha-plan-with-final-workflow>). These are this owner's acceptance obligations; the decision record remains there.

- [ ] Reserve src/lib/components/ResultsState.svelte as the small shared visual for pending or unavailable published results, consumed by the case owner and result-dependent view owners. Show a meaningful safe status/reason and relevant next action without fake results or private-candidate data. Preserve the current navigation; no separate navigation redesign is required.
- [ ] Keep the shell usable through stable case identity when no publication/resultsVersion exists. Do not make independent user-work access depend on an active result version.
