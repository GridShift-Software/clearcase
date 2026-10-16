# Implement hosted D1 results storage and protected R2 assets

Planning snapshot, 16 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-115/implement-hosted-d1-results-storage-and-protected-r2-assets) is the execution authority.

Planning key `HA-storage`. Hosted-alpha delivery plan; Backlog until the overall plan is approved.

## Outcome

The hosted app reads validated immutable results and serves authorized original/preview bytes through per-client storage.

## Reserved write scope

* src/lib/storage/cloud/\*\*
* src/lib/results/hosted/\*\*
* src/routes/api/cases/\[caseId\]/assets/\*\*
* tests/hosted-foundation/storage/\*\*
* docs/hosted-foundation/storage.md
* shared local-case read-contract files only by explicit serialized handoff
* src/lib/local-case/{app,db,store,results,documents,project,model,config,originals}.server.ts (explicit serial core migration)
* src/routes/api/state/\*\*
* src/routes/api/health/\*\*
* src/routes/v/\[vid\]/+layout.server.ts (serial handoff after framework owner)

These are initial reservations. Pin exact files and accepted upstream SHA in the coordinator brief. Shared config, lockfiles, hooks and schema changes have one writer; request a handoff rather than widening scope.

## Acceptance

- [ ] Implement the proven physical layout and async storage/read contract; preserve canonical package validation/projection and immutable case/input/results identities.
- [ ] Separate originals, private candidates, published previews and user-work records. Deny wrong-client/case/version and private-candidate asset access.
- [ ] Preserve original bytes and verify-on-load/fail-closed behavior, including the accepted range-delivery proof. Active original content cannot execute with app privileges.
- [ ] Make acknowledged upload/finalization and imported asset references durable with explicit failure/retry behavior; no local filesystem/SQLite dependency in hosted requests.
- [ ] Hand storage adapter ownership to intake only after acceptance; serialize later shared adapter writes through the coordinator. Product import/publish state transitions remain their own owners.

## Verification and handoff

Run real D1/R2/Workers storage and original-byte/range tests on synthetic files, including corruption, missing objects, reused identifiers and crossed client namespaces. Meet approved measured budgets and record exact SHA.

Use doctor at session start and verify/receipt for checks. Return PASS/HOLD/FAIL at the exact revision, changed paths, commands/exit codes, evidence and unresolved findings. Required skipped or mocked checks do not pass. One fresh independent diff review, one bounded written-finding fix and fresh recheck; only the coordinator changes Linear. No work starts while native blockers remain open.

## Boundaries

Planning creates this issue; it does not dispatch it. RAWS/current production are read-only. Shared pools/committed fixtures use synthetic data; case material, private screenshots and secrets stay out of Git and external services. No production deployment, real external messages, destructive retention action or main merge under this planning update. Normal Opus/Sonnet roles apply; a rare Fable/Astra escalation requires a separate linked issue before dispatch and results recorded afterward.

## Native prerequisites

* [Chart the route from the ClearCase POC to hosted alpha](<https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha>)
* [Gate the hosted design before client intake implementation](<https://linear.app/vaper/issue/GRS-27/gate-the-hosted-design-before-client-intake-implementation>)
* [Provision isolated client instances, cases and explicit grants](<https://linear.app/vaper/issue/GRS-114/provision-isolated-client-instances-cases-and-explicit-grants>)
