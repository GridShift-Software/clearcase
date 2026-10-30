# 05: Journeys and request budget in the repo
**Wave:** 0 · **Size:** 0.5 d · **Security-sensitive:** no · **Suggested agent:** standard (Sonnet / Terra)
## What to build
Any developer runs `bun tests/journeys/run-all.mjs` (alias `bun run journeys` once 01 lands) against the local app, a preview or staging by changing environment variables, and gets a PASS/FAIL table with timings per step for J1–J10. A Vitest test counts D1, Clerk and R2 calls per hosted route through the existing hosted test doubles and fails above the budget; later tickets add one file each for their routes.

How: move `/home/vaper/Work/Active/MX-two/ClearCase/clearcase/.local/astra/journeys/{lib.mjs,J1.mjs…J10.mjs,run-all.mjs,README.md}` into `tests/journeys/`, stripping every case-specific value: `CASE_ID`, `RESULTS_VERSION`, `SMALL_REF`, `MEDIUM_REF`, `LARGE_REF`, `SEARCH_REF`, `EXPECTED_DOCUMENTS`, `EXPECTED_SHA`, `CREDENTIALS_JSON`, `STORAGE_STATE` come from env (`research/journeys.md` environment list); baseline byte sizes become optional `SMALL_BYTES`/`MEDIUM_BYTES`/`LARGE_BYTES`. Keep the selector contract exactly as in `research/journeys.md` (data-testid first, local fallbacks second), the per-step budgets (pages 2,000 ms, PDF first page 3,000 ms, sign-in 5,000 ms, saves 2,000 ms, bundle 5,000 ms) and the JSON results. Add `tests/journeys/README.md` with the two command lines (local with `CLEARCASE_DATA_DIR`, hosted with `MODE=hosted BASE_URL=... CASE_ID=...`) and a `.env.example` listing every variable with no values. Budget test: `tests/hosted-foundation/budget/harness.ts` wraps the memory doubles (`src/lib/server/runtime/memory*.ts`, `tests/hosted-smoke/case-overview/doubles.ts`, `tests/hosted-foundation/storage/doubles.ts`) in counting proxies for `D1 prepare/batch/exec`, every Clerk fetch, and every R2 `get/head/list`, builds `locals` as `RequestServices`, calls a route's `load` or `GET`, and asserts `{ d1 ≤ n, clerk ≤ n, r2 ≤ n }`. `budget.ts` holds the targets: page view `{ clerk: 0, d1: 1, r2: 1 }`, PDF range `{ clerk: 0, d1: 0, r2: 1 }`, mutation `{ clerk: 0, d1: 1 }` (one batch). `05-existing.test.ts` runs the harness over the existing `/cases` and `/cases/[caseId]` loads with generous interim budgets and records today's counts in the PR body, so the regression direction is visible.
## Reserved paths (edit only these; new files under them are fine)
- `tests/journeys/`
- `tests/hosted-foundation/budget/{harness.ts,budget.ts,05-existing.test.ts,README.md}` (later tickets add `tests/hosted-foundation/budget/<nn>-<slug>.test.ts` and never edit these)
- `docs/sprint/runbooks/05-journeys.md`
Shared files this ticket owns, which others must not edit until it merges: `tests/hosted-foundation/budget/harness.ts`, `budget.ts`.
## Blocked by
- None: can start immediately
## Acceptance
- [ ] `PORT=41195 CLEARCASE_DATA_DIR=<synthetic data dir> bun run --bun start` then `BASE_URL=http://127.0.0.1:41195 MODE=local IDLE_MINUTES=2 bun tests/journeys/run-all.mjs` reproduces the 28 October local verdicts (J1, J2, J4, J6, J8, J10 PASS; J3, J5, J7, J9 FAIL for the documented reasons) with every ref coming from env.
- [ ] `grep -rn "DOC-\|sha256:" tests/journeys` finds no committed case reference or version id.
- [ ] `MODE=hosted` with a missing `EXPECTED_SHA` refuses to run with a clear message; with `READ_ONLY=1` the write journeys (J7, J8, J9) are skipped and reported as skipped, never as passed.
- [ ] `bun run --bun test tests/hosted-foundation/budget` passes and the harness fails when a route makes one Clerk call more than its budget (a self-test with a deliberately chatty fake route).
- [ ] The journeys run under `orch-bin/browser-lock` on the owner's machine and without it elsewhere (`CLEARCASE_BROWSER_LOCK=none`), per `docs/development.md` "Browser admission".
## Checks (run exactly these; paste the results in the PR)
```
bun install --frozen-lockfile && bunx svelte-kit sync && scripts/agent-tools/doctor
bunx tsc --noEmit -p .
bun run --bun test tests/hosted-foundation/budget tests/hosted-smoke/case-overview
BASE_URL=http://127.0.0.1:41195 MODE=local IDLE_MINUTES=2 bun tests/journeys/run-all.mjs    # local app running on 41195
```
## Read first
`research/journeys.md` (all); `.local/astra/journeys/README.md` (selector fallbacks); `docs/development.md` "Hosted runtime", "Test doubles and the GRS-138 feature map", "Browser admission"; `spec.md` "Testing Decisions" seams 2 and 3.
## Decisions already made (don't re-decide)
- The journey scripts live in `tests/journeys/` as plain `.mjs` (not collected by Vitest); nothing case-specific is committed.
- The budget test lives under `tests/hosted-foundation/budget/` because `tests/hosted-foundation/**` is already collected; a new top-level `tests/budget/` would be dropped by the collector.
- Budgets are the spec's: per page view 0 Clerk, at most 1 D1, at most 1 R2; per PDF range request 0 D1, 1 R2; a mutation is one D1 batch. Existing routes get interim budgets that only tighten.
- Timings for the release gate come from the owner's South African network with Astra; this ticket makes the scripts runnable anywhere and does not claim p95.
- `data-testid` hooks are added by the ticket that owns each page, not here.
## Forbidden
Editing outside the reserved paths; `dev` or `main`; real case material or secrets in Git (no case ids, refs, version ids, credentials); new guards, receipts or process files; a second review round; loosening tests; redeploying sandboxes A or B; editing the hosted doubles themselves or `vitest.config.ts`; editing `package.json` (01 adds the alias).
## Done means
PR merged into sprint/hosted-demo-20261105 with a merge commit; staging deployed at that SHA (once 02 exists); `bun tests/journeys/J1.mjs` with `MODE=hosted` reaches the case list on staging; the Linear issue is Done with the merge SHA; Lows go as a `follow-ups:` comment on the issue.
