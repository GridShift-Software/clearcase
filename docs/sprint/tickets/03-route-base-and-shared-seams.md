# 03: Route base, hosted availability and shared seams
**Wave:** 0 · **Size:** 0.5–1 d · **Security-sensitive:** no · **Suggested agent:** strong (Opus / Sol)
## What to build
Every link the view pages render (citations, navigation, document routes, "go to" links) works under a base prefix, so the same page component serves `/v/<rv>/...` locally and `/cases/<caseId>/v/<rv>/...` on hosted. The sidebar knows which views hosted offers: ported, coming soon or never. The hosted import guard accepts stylesheet imports, and the hosted tree loads the one global stylesheet. A shared shell component (sidebar plus top bar with search, version pill and account) exists, unstyled, with a fixed props contract, so 06 can fill it with hosted data and 10 can style it. The local app is unchanged in behaviour: J1 passes locally.

How: P0, P2, P5 and the two spike fixes from `research/view-contracts.md` section 5 and `research/spike-hosted-views.md` sections 1 and 5. `versionPath(rv, base = '/v')` in `src/lib/local-case/model.ts`; `documentRoute(rv, ref, page, base = '/v')` in `src/lib/case-package/render.ts`; `viewHref(rv, v, base)` in `src/lib/components/views.ts`. The layout returns `base`; `CitationLink` and `ViewNav` read `base` from a Svelte context the layout sets (`setContext('clearcase:base')`), with the default `/v`. The eight pages that build hrefs (timeline, chronology, doc, contracts, documents, filings, search, elements) pass `data.base`. Chronology `+page.ts` fetches `data.listHref` instead of a hard-coded `/api/v/...` (P5). New `src/lib/views/hosted/availability.ts`: `hostedStatus(viewId): 'ported' | 'soon' | 'never'` from a map keyed by registry id; system views `never`, overview `ported`, everything else `soon` until a later ticket flips it (each later ticket edits only its own ids, one line each; conflicts there are one-line and resolved by whoever merges second). `ViewNav` greys `soon` and omits `never` when a `hosted` flag is set; `UnavailableView` gets a `status` prop with client wording ("Coming soon", a return link, no counts). New `src/lib/components/shell.ts` (type `ShellData`), `AppShell.svelte` (sidebar slot, `<main id="main" data-ready={current}>`) and `TopBar.svelte` (brand, case name, GET search form to `searchHref` with `data-testid="search-input"` and `search-submit`, version pill, account name and sign-out link, action links); the local `v/[vid]/+layout.svelte` uses them. Move the hosted root layout's `:global` tokens into `src/app.css` (drop the Montserrat `@font-face` lines; system stack), import `$lib/../app.css` from `deploy/client/routes/+layout.svelte`, and render that layout bare (no header, no `<main>`) when `page.route.id` starts with `/cases/[caseId]/v/[version]`. Add the `$local` alias (`src/routes/v/[vid]`) in `vite.config.ts` so hosted wrapper pages can `import Page from '$local/<view>/+page.svelte'`. In `scripts/ci/hosted-imports.ts` add a stylesheet rule before the `.svelte` rule (a `.css` specifier resolves when the file exists; nothing to walk), with a mutant in `tests/hosted-foundation/runtime/guard-mutations.ts` and a case in `hosted-imports.test.ts`.
## Reserved paths (edit only these; new files under them are fine)
- `src/lib/local-case/model.ts`, `src/lib/case-package/render.ts`, `src/lib/components/views.ts`
- `src/lib/components/{CitationLink,ViewNav,UnavailableView,Narrative,AppShell,TopBar}.svelte`, `src/lib/components/{CitationLink,ViewNav}.test.ts`, `src/lib/components/shell.ts`
- `src/routes/v/[vid]/+layout.svelte`, `src/routes/v/[vid]/+layout.server.ts`, `src/routes/v/[vid]/chronology/`
- `+page.svelte` only in `src/routes/v/[vid]/{analysis/timeline,doc/[ref],evidence/contracts_tab,evidence/documents,evidence/filings_tab,evidence/search,litigation/elements_tab}/`
- `src/lib/views/hosted/availability.ts`, `src/lib/views/hosted/availability.test.ts`
- `scripts/ci/hosted-imports.ts`, `tests/hosted-foundation/runtime/guard-mutations.ts`, `tests/hosted-foundation/runtime/hosted-imports.test.ts`
- `src/app.css`, `deploy/client/routes/+layout.svelte`, `vite.config.ts`
Shared files this ticket owns, which others must not edit until it merges: all of the above; 04 edits `+page.server.ts` in some of the same route folders, never the `+page.svelte`.
## Blocked by
- None: can start immediately
## Acceptance
- [ ] `versionPath('sha256:…')`, `documentRoute(...)`, `viewHref(...)` return today's paths with no base argument, and `/cases/c1/v/sha256:…/doc/DOC-1?page=3` with base `/cases/c1/v` (unit tests).
- [ ] Local J1 steps 1–3 pass (`bun tests/journeys/run-all.mjs` once 05 exists, else `.local/astra/journeys/J1.mjs`): all 42 nav entries open, every citation on the timeline page resolves to a `/v/...` document route.
- [ ] `ViewNav` with `hosted` set renders `soon` entries with `aria-disabled="true"` and `data-hosted-status="soon"`, and no system entries (component test).
- [ ] `TopBar` renders `search-input`, `search-submit`, the version pill text and the account controls from `ShellData` (component test).
- [ ] `bun run --bun check:hosted-imports` passes with a `.svelte` under `deploy/client/routes` importing `$lib/views/analysis/analysis.css`; `bun run --bun probe:hosted-imports` kills the new mutant.
- [ ] `bun run --bun build:hosted` passes; the hosted root layout still renders `main#main[data-ready]` for `/cases` (existing `tests/hosted-smoke/case-overview` green).
## Checks (run exactly these; paste the results in the PR)
```
bun install --frozen-lockfile && bunx svelte-kit sync && scripts/agent-tools/doctor
bunx tsc --noEmit -p .
bunx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings
bunx vitest related src/lib/local-case/model.ts src/lib/case-package/render.ts src/lib/components/views.ts --run
bun run --bun test src/lib/components src/lib/views tests/case-package tests/system tests/hosted-foundation/runtime tests/hosted-smoke/case-overview
bun run --bun check:hosted-imports && bun run --bun probe:hosted-imports && bun run --bun build:hosted
scripts/preview.sh      # once 02 exists: /cases still renders; note ms
```
## Read first
`research/view-contracts.md` sections 3 and 5 (P0, P2, P5); `research/spike-hosted-views.md` sections 1 and 5 (traps 2, 4, 5, 10); `research/ui-spec.md` section 1 (shell data: case name, active route, published label, document count, search, account); `research/journeys.md` selector contract; `docs/development.md` "Adding a view".
## Decisions already made (don't re-decide)
- Hosted route prefix is `/cases/<caseId>/v/<rv>/<category>/<view>`; the hosted folder keeps the existing param name `[version]` (the preview-asset route already lives there). `base` for hosted is `/cases/<caseId>/v`.
- `src/lib/components/view-registry.ts` and `docs/plan/view-coverage.json` are never edited; the overlay is the only hosted status.
- `ShellData` is: `{ brand, caseName, base, resultsVersion, current, published: { label, at, documents } | null, searchHref, account: { name, signOutHref } | null, actions: { label, href }[] }`. Later tickets may add optional fields, never rename.
- Hosted pages re-export local page components through `$local`, they are not copied. Local pages keep working with the default base.
- System font stack only: remove the Montserrat `@font-face` rules; leave the font files for 10 to delete.
- `UnavailableView` client copy: view name, "Coming soon", a return link to the overview; no owner or blocker text when `status` is set.
- `src/app.css` is the single global stylesheet from now on; the hosted root layout owns no tokens.
## Forbidden
Editing outside the reserved paths; `dev` or `main`; real case material or secrets in Git; new guards, receipts or process files; a second review round; loosening tests; redeploying sandboxes A or B; editing `payloads.ts` or any `+page.server.ts` (04's); creating anything under `deploy/client/routes/cases/[caseId]/v/[version]/` (06's); styling beyond what keeps the local app readable (10's).
## Done means
PR merged into sprint/hosted-demo-20261105 with a merge commit; staging deployed at that SHA (once 02 exists); local J1 steps 1–3 pass and the hosted `/cases` page still renders on staging; the Linear issue is Done with the merge SHA; Lows go as a `follow-ups:` comment on the issue.
