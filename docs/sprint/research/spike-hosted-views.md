# Spike: local view pages inside the hosted client Worker (28 Oct 2026, Fable 5.1)

**Verdict: feasible, and cheap per view.** Three local pages (overview, Risk Matrix, chronology) with their components and a ViewNav layout build for Workers, pass the hosted import guard, tsc and svelte-check, and render on native workerd from JSON shards in local R2 in 4–30 ms. Two things broke (a CSS import and the missing `app.css`), both fixed in minutes. The real work is the shard producer and three shared seams (paths, placeholder route, stylesheet), which must land before parallel builders start.

- Spike worktree: `clearcase/worktrees/spike-hosted-views-20261028`, branch `spike/hosted-views-20261028`, commit **a1e5b98e** on top of sprint head 21dfb2b7. Not pushed. Synthetic data only.
- Routes: `deploy/client/routes/cases/[caseId]/v/[rv]/{+layout.server.ts,+layout.svelte,overview/,analysis/risk_matrix_tab/,chronology/}`. Shared: `src/lib/views/hosted/{view-payloads.ts,shards.server.ts}`, `scripts/spike/build-view-shards.ts`, `ViewNav.svelte` (`base` prop), `scripts/ci/hosted-imports.ts` (CSS rule), `scripts/pilot/hosted.ts` (`CLEARCASE_SPIKE_SHARDS` seeding).

## 1. Build

Pages were copied verbatim; the only edits were a typed `data` prop (`ViewLayoutData & <Shard>`), the overview's "Go to" links using `data.base`, and dropping the rollback form. Loaders are 9 lines each: `viewParams(params)` then `readShard<T>(caseId, rv, name)` from `env.BUCKET` (`cloudflare:workers`). Shards are the local loaders' return values minus `version`, under `rm/<caseId>/<rv>/{shell,overview,chronology,analysis/risk-matrix}.json`.

What broke, exact errors, fixes:
1. `check:hosted-imports`: `hosted-import: deploy/client/routes/cases/[caseId]/v/[rv]/analysis/risk_matrix_tab/+page.svelte: unresolved $lib/views/analysis/analysis.css`. The guard hands `.css` specifiers to `ts.resolveModuleName`, which cannot resolve them. Fix: a stylesheet rule before the `.svelte` rule (relative or `$lib/` path must exist; nothing to walk). 15 lines. Needs a mutant in `tests/hosted-foundation/runtime/guard-mutations.ts` (`probe:hosted-imports` not run here). Also affects `quantum.css` and `viewer.css`.
2. The hosted tree never imports `src/app.css`; the hosted root `+layout.svelte` carries only its own `:global` tokens, so `.card`, `.grid`, `.kpi-grid`, `.case-shell`, `.chrono`, `.filters` had no styles. Fix: `import '$lib/../app.css'` in the `[rv]` layout. Both stylesheets now set `body`, `table`, `button`; the restyle lane must own one of them.
3. No `./$types` for hosted routes under the local `svelte-kit sync` (the hosted build regenerates them, then re-syncs the local tree). Fix: `RequestEvent` from `@sveltejs/kit` and explicit `data` types, as the existing hosted routes do.
4. `versionPath`/`docPath` (`src/lib/local-case/model.ts`) hardcode `/v/<rv>`: every `CitationLink`, `Narrative` and chronology ref link renders `href="/v/sha256%3A…/doc/DOC-00001"`, which the hosted catch-all answers with 503. ViewNav got a `base` prop in the spike; `docPath` and `views.ts viewHref` still need the same parameter (one shared edit).
Nothing else broke: no server-only import, no `$app` difference (`$app/state`, `$app/navigation` are allowlisted), no fs or Bun API in the page graph. `overview-widgets.ts`'s `import.meta.glob` passes the guard; the spike feeds `status: 'unavailable'` slots.

Checks at a1e5b98e (all PASS unless noted): `check:hosted-imports` PASS production (295 modules) and hosted-gate (251); `tsc --noEmit -p .` PASS 9.4 s; `svelte-check --fail-on-warnings` 2,703 files 0 errors 12.6 s (one error in the generator fixed before the commit); `build:hosted` production PASS 6.7 s, artifact scan PASS (216 emitted modules, baseline 182); `build:hosted` hosted-gate PASS; vitest `tests/hosted-foundation/runtime/hosted-imports.test.ts` + `hosted-artifact.test.ts` 111 passed; `src/lib/components` 231 passed. Not run: `gate`, `gate:hosted`, `test:hosted`, `probe:hosted-imports`, browser.

## 2. Bundle size

`node node_modules/wrangler/bin/wrangler.js deploy --dry-run --config deploy/client/wrangler.toml` (production artifact):
- Baseline 21dfb2b7: **Total Upload 3337.84 KiB / gzip 664.39 KiB**. With layout + 3 views (a1e5b98e): **3403.59 KiB / gzip 677.27 KiB**, so +65.8 KiB raw, +12.9 KiB gzip. Server entries: overview 16.2 KB, chronology 11.1 KB, risk matrix 5.2 KB, layout 3.3 KB, loaders 0.4 KB each, plus shared chunks (DataGrid, csv, format).
- Extrapolation to 42 views (14x): about +0.9 MB raw / +0.18 MB gzip, so roughly **4.3 MB raw / 0.86 MB gzip**.
- Limit: developers.cloudflare.com/workers/platform/limits (page dated 12 Oct 2026) says Worker size **64 MiB uncompressed on Free and Paid, no compressed limit**. Over 90% headroom either way. The old 3/10 MB gzip figure is gone from the page.
- Of the baseline, `entries/hooks.server.js` is 1.04 MB raw, mostly `@cloudflare/puppeteer` (98 modules) and rxjs from the native render check; architecture.md already proposes bypassing it.
- pdf.js is **not** in the Worker script: `.svelte-kit/cloudflare/pdfjs/{pdf.min.mjs,pdf.worker.min.mjs,pdf-reader.mjs}` plus fonts and cmaps are static assets behind the ASSETS binding (254 asset files baseline, 269 with the spike's CSS/JS chunks).

## 3. Runtime (native workerd via `wrangler dev --local`, Node 26.10.0, hosted-gate profile, shards in local R2)

`PORT=43911 CLEARCASE_SPIKE_SHARDS=$PWD/.local/spike-shards bun run --bun start:hosted`, then curl with `%{time_starttransfer}`.
- Start to `/health` OK: **7.6 s** (06:38:46.83 to 06:38:54.43), including 9 Wrangler CLI calls for D1 and R2 provisioning and the workerd boot; `/health` itself 16 ms.
- First page request, isolate idle 10 min after only `/health`: overview **87 ms** TTFB.
- Warm, 5 runs each: overview **4.3–6.1 ms** (24.3 KB HTML, server log 3–6 ms); risk matrix **4.0–5.5 ms** (27.5 KB); chronology **23.5–30.6 ms** (1,013 KB HTML; shard read 4–6 ms for 882 KB, the rest SSR and page-data serialization; server log 23–30 ms). Shell shard read 1–2 ms per page.
- Negatives: unknown `rv` 404 in 5 ms; an unported view (`/analysis/matter`) **503 "Hosted runtime is unavailable"** in 2 ms from `deploy/client/routes/[...path]/+server.ts`.
- Rendered HTML checked: `id="count-documents" data-count="1689"`; 42 nav links all under `/cases/case-a1/v/<rv>/…`; risk table 12 rows with `an-card`/`an-table` classes; chronology DataGrid SSRs 150 rows, the full row set rides along as page data.
- Shard sizes for a v5-sized synthetic case (1,689 rows): shell 317 B, overview 2.2 KB, risk matrix 2.6 KB, chronology **882 KB**. Whole-chronology shards do not scale (100k documents is about 50 MB); the chronology shard must page and filter server-side, as the existing hosted `views/[resultsVersion]/chronology` route already does with GET parameters.

## 4. Effort

Wall clock 06:23 to 06:50 (27 min) for worktree, reading, three pages, generator, builds and measurement. Of that: reading docs and code 10 min; copying three pages, layout, loaders, types and shard reader 3 min; guard fix and seeding hook 2 min; synthetic generator 5 min; builds and checks 3 min; runtime measurement 2 min (a tool wait cost the rest). A single read-only view costs about 2 min of copy and 9 lines of loader once the shard shape exists; the shard shape is the local loader's return type, read off `+page.server.ts`.

Extrapolation per family (one agent, including a smoke curl, excluding the real payload builder): read-only dataset views (analysis 7, litigation 7, quantum 6, people, entities: 22 pages) **20–30 min each, 3–4 h per family of 7**, or under 2 h with one generic `[view]` route and a shard-name map instead of 7 identical loaders. Document-row views (documents, search, contracts, filings, hoa_diff, doc/[ref]) **0.5–1 day each** because of paging, facets and originals links. User-work views (7 registers, notes) are not shard-fed and need the `D1UserWork` adapter: not measured here. The payload builder (local loader logic run over the package at publish) is the real cost and is per seam, not per view: roughly 1 day for dataset views, 1–2 for document rows.

A ticket that lets an agent port one family in under 2 h must contain: the exact source directory to copy (`src/routes/v/[vid]/<category>/`) and target prefix; the shard names and the types to append in `view-payloads.ts` (one file per family, see trap 1); the typed `data` prop pattern and the `RequestEvent` loader (point at `analysis/risk_matrix_tab/+page.server.ts` in the spike); the generator or builder entry to extend; the fixed list of checks (`check:hosted-imports`, `tsc`, `svelte-check`, `build:hosted`, commit, `start:hosted` with `CLEARCASE_SPIKE_SHARDS`, curl each route, `start:hosted --stop`); the reserved paths; and the instruction to leave `docPath`, `app.css`, `ViewNav`, the catch-all and the registry alone.

## 5. Traps for parallel builders

1. **One types file**: everyone appending to `src/lib/views/hosted/view-payloads.ts` conflicts on merge; split it per family (`payloads/analysis.ts`, …) before fan-out.
2. **Shared seams to land first, by one worker**: `docPath`/`versionPath` parameterization (`model.ts`, `views.ts`, `CitationLink`, `Narrative`, chronology), the `[rv]/+layout.svelte` with `app.css`, a `[rv]/[category]/[view]` placeholder route (today every unported view is a 503 from the catch-all, so the nav shows 42 links and 39 dead ends), and the CSS rule in `hosted-imports.ts` with its probe mutant.
3. **Generated types**: `build:hosted` rewrites `.svelte-kit` for the hosted tree and re-syncs; running `check` or `svelte-check` in the same worktree at the same time sees the wrong tree. One hosted build per worktree at a time.
4. **Registry coupling**: `view-registry.ts` is generated from `docs/plan/view-coverage.json` (`check` fails on drift); its `status` is the local app's availability, not hosted's. A hosted status needs its own map, not registry edits.
5. **CSS globals**: `src/app.css` (27.8 KB) and the hosted root layout both define `body`, `table`, `button`, tokens; `analysis.css`/`quantum.css` are imported by pages. The restyle lane and the view lanes touch the same files; agree ownership of `app.css` and the hosted root layout.
6. **Test inventories**: `scripts/ci/summary.ts` fails CI for any tracked `*.test.ts` Vitest did not collect; `vitest.config.ts` collects `deploy/client/routes/**/*.test.ts` (so a test beside a hosted route is fine) but a new directory outside its globs is silently dropped and then fails CI. `tests/parity/m2-base.test.ts` ("vitest includes") asserts exact counts: 9 synthetic root files, every file in `tests/hosted-smoke/native-viewer/` (currently 9), 18 listed; adding a test file to that directory or a new include glob breaks it. Put new tests under existing globs only.
7. **Runtime iteration**: `start:hosted` refuses a dirty tree or a stamp that is not HEAD, so every runtime check needs a commit first.
8. **Overview slots**: `overview-widgets.ts` globs `src/lib/views/*/overview-widgets.ts` into the hosted bundle; the shard must carry `slots` or the component throws.
9. **Chronology payload**: Kit serializes the whole `rows` array into the HTML for hydration (1 MB for 1,689 rows); page it or hydrate from a fetch.
10. **`current` in the layout** is `page.route.id.split('/').at(-1)`, right for concrete routes, wrong under a dynamic `[category]/[view]`.

## Commands run

```
git -C clearcase worktree add clearcase/worktrees/spike-hosted-views-20261028 -b spike/hosted-views-20261028 sprint/hosted-demo-20261105
bun install --frozen-lockfile && bunx svelte-kit sync                         # 2.2 s
bun run --bun build:hosted                                                   # baseline 10.2 s, with views 6.7 s
node node_modules/wrangler/bin/wrangler.js deploy --dry-run --outdir .local/x --config deploy/client/wrangler.toml
bun run --bun check:hosted-imports; bunx tsc --noEmit -p .; bunx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings
bun scripts/spike/build-view-shards.ts --out .local/spike-shards            # 1,689 synthetic rows
CLEARCASE_HOSTED_PROFILE=hosted-gate bun run --bun build:hosted
PORT=43911 CLEARCASE_SPIKE_SHARDS=$PWD/.local/spike-shards bun run --bun start:hosted
curl -s -o /dev/null -w '%{http_code} ttfb=%{time_starttransfer}s' http://127.0.0.1:43911/cases/case-a1/v/<rv>/overview
PORT=43911 bun run --bun start:hosted --stop
bun run --bun test tests/hosted-foundation/runtime/hosted-imports.test.ts tests/hosted-foundation/runtime/hosted-artifact.test.ts src/lib/components
```

Map notes: the hosted tree has no `app.css`; `[...path]/+server.ts` is the 503 for every unmigrated route; hosted routes type `data` explicitly because `./$types` is only generated during `build:hosted`; the Worker size limit is now 64 MiB uncompressed with no compressed limit.
