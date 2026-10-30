# 15: Search
**Wave:** 2 · **Size:** 0.5–1 d · **Security-sensitive:** no · **Suggested agent:** standard (Sonnet / Terra)
## What to build
A lawyer types a reference, file name, subject or sender into the top-bar search (Ctrl+K) or the search view and gets results in under 2 seconds, with the query kept in the URL and each result linking to its document; CSV export of the results works. J6 passes on staging. Today hosted search answers 503.

How: `research/view-contracts.md` family C (search). Builder module `scripts/publish/shards/search.ts`: `search/index.json` = 04's `SearchShard`, rows from `searchRowsOf` (list plus `cc` from `documentRows`): ref, subject, filename, sender, to, cc, date, bundle, docType, excerpt. Hosted routes under the version folder: `evidence/search/+page.server.ts` reads the index through `shard()` (one R2 read cold, the edge cache warm), runs the local `runSearch` (`src/lib/views/evidence/search.ts`) extended to match ref, filename, subject and sender as well as excerpt, 50 per page, returning the local page shape (`query, submitted, result, pageNotice, actions, options, coverage, failed: [], exportName`) plus `base`; `evidence/search/export/+server.ts` streams the CSV of the current query; `search/+page.server.ts` redirects to `evidence/search` keeping `?q=`. The wrapper page re-exports `$local/evidence/search/+page.svelte`. The top bar's form (03's `TopBar`, `search-input`, `search-submit`) already posts GET to `searchHref`; the hosted layout (06) sets `searchHref` to this route, so no shell edit is needed. If time allows, port `hoa_diff_tab` the same way over the index's excerpts (`src/lib/views/evidence/diff.ts`); otherwise it stays `soon`. Flip `search` (and `hoa_diff_tab` if ported) to `ported`.
## Reserved paths (edit only these; new files under them are fine)
- `deploy/client/routes/cases/[caseId]/v/[version]/evidence/search/`, `deploy/client/routes/cases/[caseId]/v/[version]/search/`, `deploy/client/routes/cases/[caseId]/v/[version]/evidence/hoa_diff_tab/`
- `scripts/publish/shards/search.ts`
- `src/lib/views/evidence/search.ts`, `src/lib/views/evidence/diff.ts`, `src/routes/v/[vid]/evidence/search/+page.server.ts` (if `runSearch`'s signature changes)
- `src/lib/views/hosted/availability.ts` (the `search` and `hoa_diff_tab` lines only)
- `tests/publication/shards/15-search.test.ts`, `tests/evidence/15-*.test.ts`, `tests/hosted-foundation/budget/15-search.test.ts`
Shared files this ticket owns, which others must not edit until it merges: `src/lib/views/evidence/search.ts`.
## Blocked by
- 06 TRACER (merged into the sprint branch)
## Acceptance
- [ ] J6 on staging: typing a known reference into `search-input` and submitting lands on the search view with `?q=<reference>` in the URL and the matching document link visible, under 2 s from submit to results; timings in the PR.
- [ ] Searching by a file name fragment, a subject word and a sender address each return the expected fixture document on the preview (three curl or Playwright checks with synthetic refs).
- [ ] CSV export of a query downloads the result rows from the preview.
- [ ] Budget (`tests/hosted-foundation/budget/15-search.test.ts`): a search page view makes at most 1 D1 and 1 R2 cold, 0 warm; the index parse for the v5-sized fixture takes under 100 ms in the test.
- [ ] Local search still passes its tests with the widened matching (`tests/evidence`); `runSearch` over excerpt-only input behaves as before.
## Checks (run exactly these; paste the results in the PR)
```
bun install --frozen-lockfile && bunx svelte-kit sync && scripts/agent-tools/doctor
bunx tsc --noEmit -p .
bunx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings
bunx vitest related <changed src files> --run
bun run --bun test tests/publication/shards tests/evidence src/lib/views tests/hosted-foundation/budget
bun run --bun check:hosted-imports && bun run --bun build:hosted
scripts/preview.sh      # walk J6 from the top bar and from the view, note ms
```
## Read first
`research/view-contracts.md` section 1 (search, hoa_diff rows), 2 (C); `research/journeys.md` J6 hooks; `research/ui-spec.md` section 1 (global search behaviour); `src/lib/views/evidence/search.ts`.
## Decisions already made (don't re-decide)
- One index shard `search/index.json` (about 1.6 MB for v5), cached immutable at the edge; no FTS, no token-prefix shards, no full text in this sprint.
- Matching covers ref, filename, subject, sender and excerpt; results 50 per page; the query lives in `?q=`.
- The top-bar search is 03's and 10's; this ticket only serves the destination.
- `hoa_diff_tab` is optional here; if not ported it stays "Coming soon".
## Forbidden
Editing outside the reserved paths; `dev` or `main`; real case material or secrets in Git; new guards, receipts or process files; a second review round; loosening tests; redeploying sandboxes A or B; editing `TopBar`, `AppShell` (10's), the builder framework or `payloads.server.ts` (06's), `payloads/*` (04's).
## Done means
PR merged into sprint/hosted-demo-20261105 with a merge commit; staging deployed at that SHA; J6 passes there; the Linear issue is Done with the merge SHA; Lows go as a `follow-ups:` comment on the issue.
