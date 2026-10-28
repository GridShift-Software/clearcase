# 13: Analysis views, part 1
**Wave:** 2 · **Size:** 0.5–1 d · **Security-sensitive:** no · **Suggested agent:** standard (Sonnet / Terra)
## What to build
On staging, Matter & Strategy, Timeline, Contradiction Tracker, Risk Matrix, Defence & Rebuttal, Witnesses, People, Entities and Conflict Check show the analysis the processing surfaced, every figure and finding citing its documents, with CSV export where the local view has one, each page in under 2 seconds. J5 passes for these nine views.

How: `research/view-contracts.md` family B and `research/spike-hosted-views.md` section 4 (the generic route pattern). Builder module `scripts/publish/shards/views-analysis.ts`: for each of `matter`, `timeline`, `contradictions_tab`, `risk_matrix_tab`, `vdm_matrix_tab`, `witness_tab`, `people`, `entity_ledger_tab`, `conflict_tab`, call the local loader (`src/routes/v/[vid]/<category>/<view>/+page.server.ts` `load`) with the fake `parent()` the framework supplies and write `view/<viewId>.json`; set `vdm_matrix_tab.analysisAdditions` to false. Hosted routes under `deploy/client/routes/cases/[caseId]/v/[version]/`: `analysis/{matter,timeline,contradictions_tab,risk_matrix_tab,vdm_matrix_tab,witness_tab}/`, `evidence/{people,entity_ledger_tab}/`, `litigation/conflict_tab/`, each `+page.server.ts` = `export const load = datasetView('<viewId>', isEmpty)` (06's factory; `isEmpty` is a one-line predicate per view: no rows, no narrative) and `+page.svelte` re-exporting the local page through `$local` inside `<div data-testid="analysis-content" data-empty={String(data.empty)}>`. Add a seam-1 test: for each view, the hosted loader's props from the shard equal the local loader's props from the fixture store (minus `base`, `empty`). Flip the nine `hostedStatus` lines to `ported`.
## Reserved paths (edit only these; new files under them are fine)
- `deploy/client/routes/cases/[caseId]/v/[version]/analysis/{matter,timeline,contradictions_tab,risk_matrix_tab,vdm_matrix_tab,witness_tab}/`
- `deploy/client/routes/cases/[caseId]/v/[version]/evidence/{people,entity_ledger_tab}/`, `deploy/client/routes/cases/[caseId]/v/[version]/litigation/conflict_tab/`
- `scripts/publish/shards/views-analysis.ts`
- `src/lib/views/hosted/availability.ts` (the nine lines only)
- `tests/publication/shards/13-analysis.test.ts`, `tests/analysis/13-*.test.ts`, `tests/hosted-foundation/budget/13-analysis.test.ts`
Shared files this ticket owns, which others must not edit until it merges: none.
## Blocked by
- 06 TRACER (merged into the sprint branch)
## Acceptance
- [ ] J5 on staging for the nine views: each shows `main[data-ready="<viewId>"]` and `analysis-content[data-empty="false"]` under 2 s; timings per view in the PR.
- [ ] Seam 1 (`tests/publication/shards/13-analysis.test.ts`): on the synthetic fixture, `datasetView(id)` over the built shard deep-equals the local `load` output for all nine views.
- [ ] Every citation on these pages resolves under the hosted base (`/cases/v5-demo/v/<rv>/doc/...`), checked by crawling the rendered HTML of the preview for `href="/v/`: zero hits.
- [ ] CSV export on contradictions and the defence matrix downloads from the preview.
- [ ] Budget (`tests/hosted-foundation/budget/13-analysis.test.ts`): each page view at most 1 D1 and 1 R2 cold, 0 warm.
- [ ] Bundle size delta after nine views under 400 KB raw (`wrangler deploy --dry-run` in the PR).
## Checks (run exactly these; paste the results in the PR)
```
bun install --frozen-lockfile && bunx svelte-kit sync && scripts/agent-tools/doctor
bunx tsc --noEmit -p .
bunx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings
bunx vitest related <changed src files> --run
bun run --bun test tests/publication/shards tests/analysis src/lib/views tests/hosted-foundation/budget
bun run --bun check:hosted-imports && bun run --bun build:hosted
scripts/preview.sh      # open the nine views, note ms; curl each for href="/v/
```
## Read first
`research/view-contracts.md` section 1 (the nine rows), 2 (B); `research/spike-hosted-views.md` sections 1, 4; `research/ui-spec.md` sections 6–13; `research/journeys.md` J5 hook; `docs/development.md` "Adding a view".
## Decisions already made (don't re-decide)
- Shards are the local loaders' return values; the Worker never opens a dataset. `analysisAdditions` is false on hosted.
- One generic loader factory (06's `datasetView`); nine 1-line loaders, nine 3-line wrapper pages. No copying of page markup.
- Pages keep local content, provenance and CSV; only tokens change (10). Nothing is invented for views the prototype left as placeholders.
- `availability.ts`: flip only your nine lines; a conflict there is one line, resolved by whoever merges second.
## Forbidden
Editing outside the reserved paths; `dev` or `main`; real case material or secrets in Git; new guards, receipts or process files; a second review round; loosening tests; redeploying sandboxes A or B; editing the builder framework, `payloads.server.ts`, the version layout (06's), any local `+page.svelte`, `analysis.css` (10's), `payloads/*` (04's).
## Done means
PR merged into sprint/hosted-demo-20261105 with a merge commit; staging deployed at that SHA; J5 passes for the nine views there; the Linear issue is Done with the merge SHA; Lows go as a `follow-ups:` comment on the issue.
