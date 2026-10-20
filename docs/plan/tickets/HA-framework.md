# Migrate the app build and shared server entry points to Workers

Planning snapshot, 20 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-112/migrate-the-app-build-and-shared-server-entry-points-to-workers) is the execution authority.

## User decision — 19 October 2026

The user approved local Workers build/scaffolding and hosted-gate bootstrap (<issue id="f67f5b3e-15b5-4e48-9b82-a1a1d78cd700" href="https://linear.app/vaper/issue/GRS-112/migrate-the-app-build-and-shared-server-entry-points-to-workers">GRS-112</issue> → <issue id="ab5e730e-f8a2-48d3-9b1c-ff54c6fd8498" href="https://linear.app/vaper/issue/GRS-138/build-the-hosted-gate-and-the-verify-clearcase-hosted-skill-before">GRS-138</issue>) before <issue id="c99e1ba3-dc84-4bbc-aee5-f8c3c34692f2" href="https://linear.app/vaper/issue/GRS-27/gate-the-hosted-design-before-client-intake-implementation">GRS-27</issue>, once their local runtime and viewer inputs pass. Cloudflare remains pinned. This authorization covers credential-free local work with synthetic fixtures and explicitly named doubles. Real-provider acceptance and all remaining foundation work still wait for <issue id="c99e1ba3-dc84-4bbc-aee5-f8c3c34692f2" href="https://linear.app/vaper/issue/GRS-27/gate-the-hosted-design-before-client-intake-implementation">GRS-27</issue>. Every original acceptance obligation remains; do not mark incomplete or real-provider work Done from a local slice.

Local runtime prerequisite: an independently reviewed exact-SHA PASS for <issue id="3e18e69c-1912-45e4-aa6a-5e4d6ceac22c" href="https://linear.app/vaper/issue/GRS-106/prove-sveltekit-3-and-bun-builds-on-the-cloudflare-workers-runtime">GRS-106</issue>'s local workerd/software leg, not completion of its still-held provider legs. Viewer prerequisite: accepted <issue id="ea230ba7-d71a-41fa-8916-530a865a1392" href="https://linear.app/vaper/issue/GRS-97/evaluate-viewer-components-and-freeze-alpha-file-coverage">GRS-97</issue> coverage and dependency handoff. <issue id="f67f5b3e-15b5-4e48-9b82-a1a1d78cd700" href="https://linear.app/vaper/issue/GRS-112/migrate-the-app-build-and-shared-server-entry-points-to-workers">GRS-112</issue> hands <issue id="ab5e730e-f8a2-48d3-9b1c-ff54c6fd8498" href="https://linear.app/vaper/issue/GRS-138/build-the-hosted-gate-and-the-verify-clearcase-hosted-skill-before">GRS-138</issue> the independently accepted local build, stubs, fixture, boot command and feature map. Preserve the known draft defect list and rerun at the new integrated SHA.

---

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
- [ ] Added 17 October (expand before contract): land typed interface stubs for the identity, storage and user-work contracts that <issue id="c4b67eb1-ae1c-4c4a-81e6-88f2392eddd9" href="https://linear.app/vaper/issue/GRS-113/implement-clerk-invitations-sessions-and-hosted-access-checks">GRS-113</issue>, <issue id="13f1315c-d8af-4ac6-ae9a-e700a682f570" href="https://linear.app/vaper/issue/GRS-115/implement-hosted-d1-results-storage-and-protected-r2-assets">GRS-115</issue> and <issue id="b2c3b0e8-4aab-48c1-8f5e-8a3c02d7be7a" href="https://linear.app/vaper/issue/GRS-117/persist-hosted-case-user-work-with-stable-identities-and-conflict">GRS-117</issue> implement, with an in-memory test double for each, so those owners start in parallel against the stubs instead of in series. Delete each stub in the owner's ticket once the real implementation lands. Pre-add the dependencies the viewer owners already know they need (the PDF and image renderers, and the office and email parsers <issue id="ea230ba7-d71a-41fa-8916-530a865a1392" href="https://linear.app/vaper/issue/GRS-97/evaluate-viewer-components-and-freeze-alpha-file-coverage">GRS-97</issue> selects), so later owners do not queue behind the lockfile.

## Verification and handoff

Build under Bun, run workerd request/render/action smoke checks and the import-boundary negative test, then the existing required gate or its independently reviewed hosted replacement. Pin actual adapter versions and artifact SHA.

Use doctor at session start and verify/receipt for checks. Return PASS/HOLD/FAIL at the exact revision, changed paths, commands/exit codes, evidence and unresolved findings. Required skipped or mocked checks do not pass. One fresh independent diff review, one bounded written-finding fix and fresh recheck; only the coordinator changes Linear. No work starts while native blockers remain open.

## Boundaries

Planning creates this issue; it does not dispatch it. RAWS/current production are read-only. Shared pools/committed fixtures use synthetic data; case material, private screenshots and secrets stay out of Git and external services. No production deployment, real external messages, destructive retention action or main merge under this planning update. Normal Opus/Sonnet roles apply; a rare Fable/Astra escalation requires a separate linked issue before dispatch and results recorded afterward.

## Native prerequisites

* <issue id="7e83827a-23fd-431a-96c5-3d2471790e1c" href="https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha">GRS-69</issue>: approved hosted-alpha plan.
* <issue id="75c4dcbc-09d3-4db9-b156-0c1fb1ea6aa7" href="https://linear.app/vaper/issue/GRS-104/align-agent-tooling-with-the-canonical-pstack-plugin-and-delivery">GRS-104</issue> and <issue id="617fe50a-a4ea-45e2-8834-659b007ffdf6" href="https://linear.app/vaper/issue/GRS-139/ci-verdict-without-github-pc1-vm-verify-and-verdict-answer-pass-or">GRS-139</issue>: accepted tooling and CI inputs.
* <issue id="ea230ba7-d71a-41fa-8916-530a865a1392" href="https://linear.app/vaper/issue/GRS-97/evaluate-viewer-components-and-freeze-alpha-file-coverage">GRS-97</issue>: independently accepted local viewer evaluation and dependency handoff.

<issue id="3e18e69c-1912-45e4-aa6a-5e4d6ceac22c" href="https://linear.app/vaper/issue/GRS-106/prove-sveltekit-3-and-bun-builds-on-the-cloudflare-workers-runtime">GRS-106</issue>'s independently reviewed local runtime leg must PASS before bootstrap dispatch. Its full issue includes pinned provider work, so it is an artifact prerequisite rather than a whole-issue Done dependency. <issue id="c99e1ba3-dc84-4bbc-aee5-f8c3c34692f2" href="https://linear.app/vaper/issue/GRS-27/gate-the-hosted-design-before-client-intake-implementation">GRS-27</issue> gates the real-provider and later foundation boundary; it does not block this authorized local bootstrap.

Concrete verification reservation: tests/hosted-foundation/runtime/\*\* owns the workerd request/render/action smoke tests and the negative hosted-import-boundary test. Use this path in the dispatch brief; no other foundation owner writes it.

## Final workflow alignment — 17 October 2026

Accepted in [Stress-test the complete hosted-alpha plan with final workflow scenarios](<https://linear.app/vaper/issue/GRS-136/stress-test-the-complete-hosted-alpha-plan-with-final-workflow>). These are this owner's acceptance obligations; the decision record remains there.

- [ ] Reserve src/lib/components/ResultsState.svelte as the small shared visual for pending or unavailable published results, consumed by the case owner and result-dependent view owners. Show a meaningful safe status/reason and relevant next action without fake results or private-candidate data. Preserve the current navigation; no separate navigation redesign is required.
- [ ] Keep the shell usable through stable case identity when no publication/resultsVersion exists. Do not make independent user-work access depend on an active result version.
