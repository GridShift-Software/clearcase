# 04: Payload contract
**Wave:** 0 · **Size:** 0.5 d · **Security-sensitive:** no · **Suggested agent:** standard (Sonnet / Terra)
## What to build
The shapes of every view file (shard) exist in one shared module, typed from the local loaders' own return types, so the builder (06) and the hosted loaders (11–18) agree without talking. The nine loaders that mix results data with user work are split into a pure part, computed from the version alone, and a merge part that adds user work, so the builder can call the pure part on the operator machine. The local app is unchanged: the fixture tests pass as before.

How: P1 in `research/view-contracts.md` section 5, split per family (spike trap 1). Create `src/lib/views/payloads/` with `shell.ts`, `overview.ts`, `views.ts`, `list.ts`, `doc.ts`, `search.ts`, `bundles.ts`, `manifest.ts`, and `src/lib/views/payloads.ts` re-exporting them. Types: `ShellShard { version: { id, caseId, caseName, importId, verdict, created, inputRevisionId, titleName, brand }, documents: number }`; `OverviewShard` = the overview loader's pure return (no `notes`, `previous`, `slots`); `ViewShards` = a map from view id to `Awaited<ReturnType<typeof load>>` minus user-work fields, exported as types from each loader (`export type Shard = ...`); `ListPage { page, pages, total, rows: ChronologyListRow[] }`, `FacetsShard { bundles, docTypes, textStatuses, years: [value, count][] }`; `DocShard { ref, source, fields, state, attachments (with hasDocument), children, related, parent, assetIds: { own: string | null, attachments: string[] }, mediaType, originalState: 'available' | 'missing' | 'embedded' }`; `SearchShard { rows: SearchRow[] }` (ref, subject, filename, sender, to, cc, date, bundle, docType, excerpt); `BundlePathsShard { paths: Record<string, { ref?: string; assetKey?: string; presentation }> }`; `PayloadManifest { format: 'clearcase.shard-manifest/1', caseId, resultsVersion, manifestSha256, readModelSha256, validatorVersion, diagnosticsSha256, warningFingerprints, counts: { documents, assets, seeds, files, listPages }, builtAt, builder: { sha, bun }, shards: { name, bytes, sha256 }[] }`. Split the loaders of overview, filings, payments, interest_calc, settlement, authorities, crossexam, enforcement and info_required into `export function pure(a: { store: CaseStore; vid: string; vc: ViewContentReader; now?: () => Date })` returning the shard and `export function merge(shard, work)` returning the page data; `load` calls both. Put the pure functions beside the helpers they use (`src/lib/views/evidence/filings.server.ts`, `src/lib/views/litigation/{register,enforcement}.server.ts`, `src/lib/views/quantum/data.server.ts`, a new `src/lib/views/overview/pure.server.ts`), and keep the merge functions pure of `app()` so the hosted loaders (14b, 16, 17) can import them.
## Reserved paths (edit only these; new files under them are fine)
- `src/lib/views/payloads.ts`, `src/lib/views/payloads/`, `src/lib/views/overview/`
- `+page.server.ts` only in `src/routes/v/[vid]/{overview,evidence/filings_tab,quantum/payments_tab,quantum/interest_calc_tab,quantum/settlement_tab,litigation/authorities_tab,litigation/crossexam_tab,litigation/enforcement_tab,analysis/info_required_tab}/`
- `src/lib/views/evidence/{filings.server.ts,filings.ts}`, `src/lib/views/litigation/{register.server.ts,enforcement.server.ts,enforcement.ts,crossexam.ts,authorities.ts}`, `src/lib/views/quantum/{data.server.ts,payments.ts,interest.ts,settlement.ts}`
Shared files this ticket owns, which others must not edit until it merges: `src/lib/views/payloads.ts` and `src/lib/views/payloads/*` (later tickets add new files there and never edit these).
## Blocked by
- None: can start immediately
## Acceptance
- [ ] `bunx tsc --noEmit -p .` passes with every `ViewShards[id]` assignable from the matching loader's return type (a type-level test in `src/lib/views/payloads/payloads.test.ts` using `expectTypeOf`).
- [ ] For each of the nine split loaders, `merge(pure(...), emptyWork)` equals `load(...)` on the synthetic fixture with no user work, and `load` is unchanged with user work (tests under `tests/evidence`, `tests/litigation`, `tests/quantum`, `tests/registers` named `04-*.test.ts`).
- [ ] Local J2, J5 and J8 pass unchanged (`.local/astra/journeys/J2.mjs`, `J5.mjs`, `J8.mjs` or 05's copies).
- [ ] No pure function imports `app()`; `grep -L` in the PR body shows the merge functions import nothing from `local-case/app.server`.
## Checks (run exactly these; paste the results in the PR)
```
bun install --frozen-lockfile && bunx svelte-kit sync && scripts/agent-tools/doctor
bunx tsc --noEmit -p .
bunx vitest related <changed src files> --run
bun run --bun test src/lib/views tests/evidence tests/litigation tests/quantum tests/calculations tests/registers tests/system
bun run --bun check:hosted-imports
```
## Read first
`research/view-contracts.md` sections 1, 2 (families B, D, F) and 5 (P1); `research/spike-hosted-views.md` section 5 trap 1; `docs/development.md` "Shared contracts" and "Enumerable user-work persistence"; `docs/results-package.md` (dataset keys).
## Decisions already made (don't re-decide)
- One file per shard family; the index only re-exports. A later ticket that needs a new type adds `src/lib/views/payloads/<ticket>.ts` and imports it directly.
- Shards carry the loader's return value, not raw datasets. Exceptions carried as inputs: `prescription_tab.asOf` (computed in the Worker), `vdm_matrix_tab.analysisAdditions` (false on hosted).
- List pages hold 200 rows (06's builder); `FacetsShard` carries counts, not rows.
- The `DocShard` carries attachments with `hasDocument` and an `originalState`, so the document page makes one links call, not one per attachment.
- `pure` takes the local `CaseStore` and a view-content reader; the builder (06) runs it against a local import of the package. No new abstraction over the store.
- Retire `src/lib/views/hosted/model.ts` `OverviewData`/`ChronologyData` later (06), not here.
## Forbidden
Editing outside the reserved paths; `dev` or `main`; real case material or secrets in Git; new guards, receipts or process files; a second review round; loosening tests; redeploying sandboxes A or B; editing any `+page.svelte` (03's); editing `model.ts`, `render.ts`, `views.ts` (03's); writing the builder (06's).
## Done means
PR merged into sprint/hosted-demo-20261105 with a merge commit; staging deployed at that SHA (once 02 exists); local J2, J5 and J8 pass; the Linear issue is Done with the merge SHA; Lows go as a `follow-ups:` comment on the issue.
