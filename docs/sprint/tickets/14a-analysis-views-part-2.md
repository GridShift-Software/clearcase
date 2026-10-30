# 14a: Analysis views, part 2
**Wave:** 2 · **Size:** 0.5–1 d · **Security-sensitive:** no · **Suggested agent:** standard (Sonnet / Terra)
## What to build
On staging, Cause of Action (elements), Legality, Contracts, Quantum & Interest, Invoice Ledger and Prescription show their content with their sources and CSV exports, each page in under 2 seconds. J5 passes for these six views.

How: same pattern as 13 (`research/view-contracts.md` family B). Builder module `scripts/publish/shards/views-litigation-quantum.ts` for `elements_tab`, `legality_tab`, `contracts_tab`, `quantum_tab`, `invoice_ledger_tab`, `prescription_tab`, calling each local loader with the framework's fake `parent()`. Exceptions: `prescription_tab` depends on the clock; the shard carries the inputs (`rows`, `summary`, `headlineDate`, `note`, `known`) and the hosted loader computes `asOf` with `now()` (a small `isEmpty`-style post-step passed to `datasetView`); `contracts_tab`'s `files` map and `elements_tab`'s `viewHref` targets are pure of the version and ride in the shard. Hosted routes `litigation/{elements_tab,legality_tab}/`, `evidence/contracts_tab/`, `quantum/{quantum_tab,invoice_ledger_tab,prescription_tab}/` under the version folder: 1-line loaders, 3-line wrapper pages with `analysis-content[data-empty]`. Seam-1 test for the six. The quantum shard is about 185 KB: confirm it renders under 2 s on the preview and record the size. Flip the six `hostedStatus` lines to `ported`.
## Reserved paths (edit only these; new files under them are fine)
- `deploy/client/routes/cases/[caseId]/v/[version]/litigation/{elements_tab,legality_tab}/`
- `deploy/client/routes/cases/[caseId]/v/[version]/evidence/contracts_tab/`
- `deploy/client/routes/cases/[caseId]/v/[version]/quantum/{quantum_tab,invoice_ledger_tab,prescription_tab}/`
- `scripts/publish/shards/views-litigation-quantum.ts`
- `src/lib/views/hosted/availability.ts` (the six lines only)
- `tests/publication/shards/14a-litigation-quantum.test.ts`, `tests/litigation/14a-*.test.ts`, `tests/quantum/14a-*.test.ts`, `tests/calculations/14a-*.test.ts`, `tests/hosted-foundation/budget/14a-views.test.ts`
Shared files this ticket owns, which others must not edit until it merges: none.
## Blocked by
- 06 TRACER (merged into the sprint branch)
## Acceptance
- [ ] J5 on staging for the six views: `main[data-ready="<viewId>"]` and `analysis-content[data-empty="false"]` under 2 s each, the 185 KB quantum view included; timings in the PR.
- [ ] Seam 1 (`tests/publication/shards/14a-litigation-quantum.test.ts`): hosted props deep-equal local props for all six on the synthetic fixture, with `asOf` compared under an injected clock.
- [ ] Prescription's `asOf` on the preview is today's date, not the build date.
- [ ] Invoice ledger CSV and the quantum source link work on the preview; money is right-aligned with "—" for absent amounts (local behaviour kept).
- [ ] Budget (`tests/hosted-foundation/budget/14a-views.test.ts`): each page view at most 1 D1 and 1 R2 cold, 0 warm.
## Checks (run exactly these; paste the results in the PR)
```
bun install --frozen-lockfile && bunx svelte-kit sync && scripts/agent-tools/doctor
bunx tsc --noEmit -p .
bunx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings
bunx vitest related <changed src files> --run
bun run --bun test tests/publication/shards tests/litigation tests/quantum tests/calculations src/lib/views tests/hosted-foundation/budget
bun run --bun check:hosted-imports && bun run --bun build:hosted
scripts/preview.sh      # open the six views, note ms and the quantum payload size
```
## Read first
`research/view-contracts.md` section 1 (the six rows), 2 (B, exceptions); `research/ui-spec.md` section 15; `research/journeys.md` J5 hook; 13's ticket (same pattern; copy its loader and wrapper shapes).
## Decisions already made (don't re-decide)
- Same generic loader and wrapper as 13; the clock exception is computed in the Worker, nothing else is.
- Quantum stays one shard (185 KB, cached immutable at the edge); no splitting in this sprint.
- Keep local reconciliation, provenance and warnings; no new calculator; no prototype monetary figures.
- `availability.ts`: flip only your six lines.
## Forbidden
Editing outside the reserved paths; `dev` or `main`; real case material or secrets in Git; new guards, receipts or process files; a second review round; loosening tests; redeploying sandboxes A or B; editing the builder framework, `payloads.server.ts`, the version layout (06's), any local `+page.svelte` or `+page.server.ts`, `quantum.css` (10's), `Kpi.svelte`, `payloads/*` (04's).
## Done means
PR merged into sprint/hosted-demo-20261105 with a merge commit; staging deployed at that SHA; J5 passes for the six views there; the Linear issue is Done with the merge SHA; Lows go as a `follow-ups:` comment on the issue.
