# Prove D1 and R2 integrity, layout and POC workload performance

Planning snapshot, 17 October 2026. [Live issue](https://linear.app/vaper/issue/GRS-109/prove-d1-and-r2-integrity-layout-and-poc-workload-performance) is the execution authority.

Planning key `HA-storage-proof`. Hosted-alpha delivery plan; Backlog until the overall plan is approved.

## Outcome

Per-client D1/R2 layout, integrity and latency are measured against the POC workload before production storage is implemented.

## Reserved write scope

* tests/hosting-probe/storage/\*\*
* docs/acceptance/hosting/storage.md

These are initial reservations. Pin exact files and accepted upstream SHA in the coordinator brief. Shared config, lockfiles, hooks and schema changes have one writer; request a handoff rather than widening scope.

## Acceptance

- [ ] Run the storage research P1–P8 legs applicable to the selected design, including wrong-client access, upload/finalize, integrity, concurrent user work, complete export, corruption and restore. No Node CPU proxy is Workers acceptance.
- [ ] Select physical object/metadata layout using actual request/row/object counts and measured overhead. Preserve separate clients' resources and preview/published namespaces.
- [ ] Preserve verify-on-load and fail-closed original integrity, including an explicitly proved range-delivery path; do not weaken hashing to hit a latency target.
- [ ] Test initial POC-scale counts and byte sizes with synthetic material; record cold/warm reads, upload/export bursts, failure/retry and numeric load/latency/memory budgets.
- [ ] Freeze storage, stable asset/case/version identities and export/backup interfaces for product owners. South Africa preferred/EU fallback accepted; document actual placement without a false residency guarantee.

## Verification and handoff

Run genuine D1/R2/Workers requests on disposable synthetic resources, including corruption and intentionally crossed client identifiers. Report exact revision, commands, counts and measurements. All omitted/unavailable cases remain HOLD.

Use doctor at session start and verify/receipt for checks. Return PASS/HOLD/FAIL at the exact revision, changed paths, commands/exit codes, evidence and unresolved findings. Required skipped or mocked checks do not pass. One fresh independent diff review, one bounded written-finding fix and fresh recheck; only the coordinator changes Linear. No work starts while native blockers remain open.

## Boundaries

Planning creates this issue; it does not dispatch it. RAWS/current production are read-only. Shared pools/committed fixtures use synthetic data; case material, private screenshots and secrets stay out of Git and external services. No production deployment, real external messages, destructive retention action or main merge under this planning update. Normal Opus/Sonnet roles apply; a rare Fable/Astra escalation requires a separate linked issue before dispatch and results recorded afterward.

## Native prerequisites

* [Chart the route from the ClearCase POC to hosted alpha](<https://linear.app/vaper/issue/GRS-69/chart-the-route-from-the-clearcase-poc-to-hosted-alpha>)
* [Gate v5, newer and JSON export compatibility](<https://linear.app/vaper/issue/GRS-24/gate-v5-newer-and-json-export-compatibility>)
* [Align agent tooling with the canonical pstack plugin and delivery controls](<https://linear.app/vaper/issue/GRS-104/align-agent-tooling-with-the-canonical-pstack-plugin-and-delivery>)
* [Prove SvelteKit 3 and Bun builds on the Cloudflare Workers runtime](<https://linear.app/vaper/issue/GRS-106/prove-sveltekit-3-and-bun-builds-on-the-cloudflare-workers-runtime>)
