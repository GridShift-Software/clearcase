# 14b: Mixed views, read path
**Wave:** 2 · **Size:** 1 d · **Security-sensitive:** no · **Suggested agent:** standard (Sonnet / Terra)
## What to build
On staging, Filings, Payments & Net Claim, Interest Recalculator, Settlement, Enforcement Roadmap, Cross-examination, Authorities, Heads of Argument and Information Required render their processed content merged with the client's own rows from the database, read-only until 17b adds writes. Each page in under 2 seconds; J5 passes for these views (Heads is a register that starts empty, which J5 already treats as expected).

How: `research/view-contracts.md` family D and 04's pure/merge split. Builder module `scripts/publish/shards/views-mixed.ts`: for `filings_tab`, `payments_tab`, `interest_calc_tab`, `settlement_tab`, `enforcement_tab`, `crossexam_tab`, `authorities_tab`, `heads_tab`, `info_required_tab`, call 04's `pure(...)` and write `view/<viewId>.json`. Hosted loaders under the version folder read the shard through `shard()` (06), read the user rows through `locals.userWork` (`listRows`, `seedViews`, `listPayments` equivalents on `AsyncUserWork`; filings seeds and crossexam seed overlays from `uw_seed_overlay`), and call 04's `merge(shard, work)`; `heads_tab` and `authorities_tab` return `addId` from `crypto.randomUUID()` so the forms render. Export no actions in this ticket: where a page has the read-only switch (`src/lib/views/litigation/readonly.ts` and the register `editing` flags) pass it; where it has none, leave the form in place, it posts to a route with no action and Kit answers 405, which 17b replaces. Wrapper pages re-export through `$local` with `analysis-content[data-empty]` (`info_required_tab` and `heads_tab` count as non-empty when the shard has items or the user has rows). Seam-1 test with an empty user-work double: hosted props equal local props on the fixture. Flip the nine `hostedStatus` lines to `ported`.
## Reserved paths (edit only these; new files under them are fine)
- `deploy/client/routes/cases/[caseId]/v/[version]/evidence/filings_tab/`
- `deploy/client/routes/cases/[caseId]/v/[version]/quantum/{payments_tab,interest_calc_tab,settlement_tab}/`
- `deploy/client/routes/cases/[caseId]/v/[version]/litigation/{enforcement_tab,crossexam_tab,authorities_tab,heads_tab}/`
- `deploy/client/routes/cases/[caseId]/v/[version]/analysis/info_required_tab/`
- `scripts/publish/shards/views-mixed.ts`
- `src/lib/views/hosted/availability.ts` (the nine lines only)
- `tests/publication/shards/14b-mixed.test.ts`, `tests/litigation/14b-*.test.ts`, `tests/quantum/14b-*.test.ts`, `tests/evidence/14b-*.test.ts`, `tests/hosted-foundation/budget/14b-mixed.test.ts`
Shared files this ticket owns, which others must not edit until it merges: the nine hosted route folders (17b is blocked by this ticket and takes them next).
## Blocked by
- 06 TRACER · 04 Payload contract (both merged into the sprint branch)
## Acceptance
- [ ] J5 on staging for the nine views: `main[data-ready="<viewId>"]` under 2 s; `analysis-content[data-empty="false"]` for all but Heads (empty register, expected); timings in the PR.
- [ ] Seam 1 (`tests/publication/shards/14b-mixed.test.ts`): `merge(shard, emptyWork)` from the built shard deep-equals the local `load` with no user work for all nine.
- [ ] With rows seeded through the D1 user-work double (`tests/hosted-foundation/user-work/helpers.ts`), payments totals, enforcement statuses, crossexam seeds and filings register entries appear merged (test per view).
- [ ] Budget (`tests/hosted-foundation/budget/14b-mixed.test.ts`): each page view at most 1 D1 query for user rows beyond authorization (one `listRows` or equivalent; seeds and rows in one batch where two stores are read) and 1 R2 cold.
- [ ] No hosted route in this ticket exports `actions`; forms on the preview either hide (read-only switch) or answer 405 with the page intact.
## Checks (run exactly these; paste the results in the PR)
```
bun install --frozen-lockfile && bunx svelte-kit sync && scripts/agent-tools/doctor
bunx tsc --noEmit -p .
bunx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings
bunx vitest related <changed src files> --run
bun run --bun test tests/publication/shards tests/litigation tests/quantum tests/evidence tests/hosted-foundation/user-work tests/hosted-foundation/budget
bun run --bun check:hosted-imports && bun run --bun build:hosted
scripts/preview.sh      # open the nine views, note ms
```
## Read first
`research/view-contracts.md` section 1 (the nine rows), 2 (D), 4 (items 7–10); 04's ticket (pure/merge signatures); `docs/development.md` "Enumerable user-work persistence"; `src/lib/user-work/hosted/d1-user-work.ts`.
## Decisions already made (don't re-decide)
- Reads go straight to `locals.userWork`; the write adapter is 16's and the writes are 17b's. Do not write a second adapter here.
- The shard carries the pure half (04's types); the merge functions come from 04 unchanged.
- Payments' hash and amount formatting stay as locally; nothing is recomputed in the Worker except the merge.
- `availability.ts`: flip only your nine lines.
## Forbidden
Editing outside the reserved paths; `dev` or `main`; real case material or secrets in Git; new guards, receipts or process files; a second review round; loosening tests; redeploying sandboxes A or B; editing `answer.server.ts`, `registers.server.ts` (16's), `writes.server.ts` files (17b's), the builder framework or `payloads.server.ts` (06's), any local page, `payloads/*` (04's).
## Done means
PR merged into sprint/hosted-demo-20261105 with a merge commit; staging deployed at that SHA; J5 passes for the nine views there; the Linear issue is Done with the merge SHA; Lows go as a `follow-ups:` comment on the issue.
