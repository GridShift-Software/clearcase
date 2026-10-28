# Request budget

A hosted route may make no Clerk call and at most one D1 query and one R2 read per page view (`docs/sprint/README.md`,
"Architecture"). These tests count the calls and fail above the budget, so a route that gets chattier turns a test red instead
of a page slow.

| File | Holds |
|---|---|
| `budget.ts` | the targets: `PAGE_VIEW` `{ clerk: 0, d1: 1, r2: 1 }`, `PDF_RANGE` `{ clerk: 0, d1: 0, r2: 1 }`, `MUTATION` `{ clerk: 0, d1: 1 }` (one batch) |
| `harness.ts` | counting proxies for D1 (a statement run, one per batch, one per `exec`), R2 (`get`, `head`, `list`) and `fetch` (Clerk hosts, and any other host); `hostedWorld()`; `expectWithinBudget()` |
| `05-existing.test.ts` | the harness over `/cases` and `/cases/[caseId]` with interim budgets, and the harness self-test (a chatty route one Clerk call over its budget fails) |

Run: `bun run --bun test tests/hosted-foundation/budget`. `--disable-console-intercept` prints the counts each test records.

## Add a route

Add `tests/hosted-foundation/budget/<nn>-<slug>.test.ts`; never edit `harness.ts`, `budget.ts` or `05-existing.test.ts`.

```ts
const w = await hostedWorld();                          // storage doubles behind counting proxies, a published synthetic case
const r = await expectWithinBudget('/cases/[caseId]/views/[rv]/chronology', PAGE_VIEW, w.counters,
  () => load(routeEvent(w.locals, { caseId: 'case-a', rv: w.resultsVersion! }, url)));
```

`expectWithinBudget` returns what the route answered or threw (a Kit `error()` or `redirect()` too) with its counts, and throws
`BudgetExceeded`, naming each overrun, above the budget. For a route built on its own services, count with `countedD1`,
`countedR2` and `measure()`, which also replaces `fetch` with a counting one while the route runs.

## What a count is not

- It is a number of calls from unit doubles (node:sqlite, an in-memory bucket), not a latency and not Cloudflare behaviour.
- `hostedWorld()` uses the storage fixture's granted identity, which makes no D1 or Clerk call, and a no-op audit sink. Today's
  counts therefore leave out the grant query and the Clerk checks, and are a lower bound. Pass `identity` to measure with the
  identity a later ticket lands (the app session and its grant query).
- A fetch to a host that is not Clerk counts as `otherFetch`, which no budget allows.
