# 11: Chronology with split viewer
**Wave:** 2 · **Size:** 1 d · **Security-sensitive:** no · **Suggested agent:** strong (Opus / Sol)
## What to build
A lawyer opens the chronology on staging and sees the dated documents with filters by bundle, type, year and text status, sorted and exportable as CSV. Clicking an entry opens that document's original beside the list, with the list still visible and the selection kept; a citation opens its document in one click. The page appears in under 2 seconds. J3 passes on staging. The local chronology gains the same split pane (the local defect the spec names).

How: `research/view-contracts.md` family C and P5; `research/ui-spec.md` section 3. Hosted route `deploy/client/routes/cases/[caseId]/v/[version]/chronology/`: `+page.server.ts` returns `{ exportName, listHref, facets, base }` reading `list/facets.json`; `list.json/+server.ts` answers `?page=n` by serving `list/page-<n>.json` from the shard reader with the shard's immutable headers (one R2 read cold, none warm) and `?all=1` by concatenating the pages from the Cache API for the CSV export and the local-style client filter; `+page.svelte` is `import Page from '$local/chronology/+page.svelte'`. The local `+page.ts` (03 made it fetch `data.listHref`) loads page 1 first and the rest in the background, so the first render carries 200 rows, not 1 MB (spike trap 9); filters in `src/lib/local-case/chronology.ts` work over the loaded rows and show "No documents match" with Clear filters. Split pane: a new `src/lib/views/evidence/ChronologyPane.svelte` renders `data-testid="chronology-document-pane"` with `data-ref`, an iframe of the original's view route (`/cases/<caseId>/originals/<ref>/view`, or the local viewer path with the default base) with a labelled title, a link to the document page, and states for no selection, loading, missing original and download-only; `DataGrid.svelte` gets an optional `onselect` and a keyboard-operable Preview control per row; the list wrapper carries `data-testid="chronology-list"`. Desktop grid `minmax(600px,1fr) 8px minmax(340px,38%)`; under 40 rem the pane becomes a full-width view below the list with Back keeping filters and selection. Set `hostedStatus('chronology')` to `ported`.
## Reserved paths (edit only these; new files under them are fine)
- `deploy/client/routes/cases/[caseId]/v/[version]/chronology/`
- `src/routes/v/[vid]/chronology/`, `src/lib/local-case/chronology.ts`, `src/lib/local-case/chronology.test.ts`
- `src/lib/views/evidence/ChronologyPane.svelte`, `src/lib/components/DataGrid.svelte` (additive props only)
- `src/lib/views/hosted/availability.ts` (the `chronology` line only)
- `tests/hosted-foundation/budget/11-chronology.test.ts`, `tests/system/11-*.test.ts`
Shared files this ticket owns, which others must not edit until it merges: `DataGrid.svelte`, `src/routes/v/[vid]/chronology/`.
## Blocked by
- 06 TRACER · 10 Prototype shell restyle (both merged into the sprint branch; 10 owns `DataGrid.svelte` until then)
## Acceptance
- [ ] J3 on staging passes: chronology `main[data-ready="chronology"]` under 2 s; one click on a row shows `chronology-document-pane[data-ref=<ref>]` beside `chronology-list` (both visible at 1440); one click on a citation opens the matching document page; timings in the PR.
- [ ] J3 locally passes too (the split pane exists locally now).
- [ ] Filters by bundle, type, year and text status and the header sorts work on hosted; `aria-sort` toggles; CSV export downloads the filtered rows (`?all=1` path).
- [ ] Budget (`tests/hosted-foundation/budget/11-chronology.test.ts`): the page view makes at most 1 D1 and at most 1 R2 (cold) read; `list.json?page=2` makes 0 D1 beyond the memoised authorization and 1 R2 cold, 0 warm.
- [ ] First HTML of the chronology page is under 300 KB for the v5-sized synthetic fixture (page 1 only), measured with `curl -s -o /dev/null -w '%{size_download}'` on the preview.
- [ ] At 390 px the pane stacks below the list; Back returns to the list with the filter query intact (Playwright probe in the PR).
## Checks (run exactly these; paste the results in the PR)
```
bun install --frozen-lockfile && bunx svelte-kit sync && scripts/agent-tools/doctor
bunx tsc --noEmit -p .
bunx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings
bunx vitest related <changed src files> --run
bun run --bun test src/lib/local-case/chronology.test.ts src/lib/components tests/system tests/hosted-smoke tests/hosted-foundation/budget
bun run --bun check:hosted-imports && bun run --bun build:hosted
scripts/preview.sh      # walk J3 on the preview at 1440 and 390, note ms
```
## Read first
`research/view-contracts.md` section 1 (chronology row), 2 (C), 4 (item 13), 5 (P5); `research/spike-hosted-views.md` section 3 (chronology numbers) and trap 9; `research/ui-spec.md` section 3; `research/journeys.md` J3 hooks.
## Decisions already made (don't re-decide)
- List pages are 06's shards: 200 rows per page, `list/page-<n>.json`, `list/facets.json`; this ticket reads them and never changes the builder.
- The viewer in the pane is the hosted original view route (08's); this ticket does not touch the viewer. Missing or download-only originals show a state in the pane, never a blank iframe.
- Keep local filters, sorting, citations, CSV and truthful status words; no prototype "Save view", "Bundle from filter" or date-range controls. Divider is visual; draggable resizing is deferred.
- Mobile: list, then full-width document view; no horizontal overflow.
- Set only your own line in `availability.ts`; a conflict there is one line, resolved by whoever merges second.
## Forbidden
Editing outside the reserved paths; `dev` or `main`; real case material or secrets in Git; new guards, receipts or process files; a second review round; loosening tests; redeploying sandboxes A or B; editing `scripts/publish/` framework or list shard module (06's), `payloads.server.ts` (06's), the viewer (08's), `TopBar`/`AppShell` (10's).
## Done means
PR merged into sprint/hosted-demo-20261105 with a merge commit; staging deployed at that SHA; J3 passes there; the Linear issue is Done with the merge SHA; Lows go as a `follow-ups:` comment on the issue.
