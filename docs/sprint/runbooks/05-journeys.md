# Runbook: journeys and request budget (ticket 05)

Two checks that keep the hosted demo fast, both in the repository.

## The journeys: `tests/journeys/`

Ten real-browser journeys (J1 to J10) that print a PASS/FAIL table with a timing for every step. The full variable list, the
selector contract and the refusals are in [`tests/journeys/README.md`](../../../tests/journeys/README.md); `.env.example` there
lists every variable with no value. Case values (ids, references, sizes) come from the environment and are never committed.

Local, against the checkout's own build (the app's build revision must equal `git rev-parse HEAD`; build first if `build/` is stale):

```sh
PORT=41195 CLEARCASE_DATA_DIR=<data dir> bun run --bun start
SMALL_REF=<ref> MEDIUM_REF=<ref> LARGE_REF=<ref> EXPECTED_DOCUMENTS=<count> CLEARCASE_DATA_DIR=<data dir> \
  /path/to/orch-bin/browser-lock env BASE_URL=http://127.0.0.1:41195 MODE=local IDLE_MINUTES=2 bun tests/journeys/run-all.mjs
PORT=41195 bun run --bun start --stop
```

Off the owner's machine there is no workspace lock: set `CLEARCASE_BROWSER_LOCK=none` instead of wrapping in `browser-lock`.

Staging or a preview, from any network:

```sh
MODE=hosted BASE_URL=https://<host> CASE_ID=<case> EXPECTED_SHA=<deployed sha> SMALL_REF=<ref> MEDIUM_REF=<ref> LARGE_REF=<ref> EXPECTED_DOCUMENTS=<count> \
  CREDENTIALS_JSON=<private file> bun tests/journeys/run-all.mjs
```

- `MODE=hosted` without `EXPECTED_SHA` refuses to run (exit 2). `READ_ONLY=1` reports J7, J8 and J9 as `SKIPPED` and J10 as `PARTIAL`; neither counts as a pass.
- The first install is `(cd tests/journeys && bun install --frozen-lockfile)`. J9 needs `pdfinfo` and `pdftotext`.
- Timings from the owner's South African network with Astra feed the release gate. A run elsewhere is a smoke check, not a p95 claim.
- On 28 October the local run gave J1, J2, J4, J6, J8, J10 PASS and J3 (no split pane), J5 (one analysis view with no rows), J7 (a document note is missing from the case notes list) and J9 (the assembled bundle PDF is lost after a reload) FAIL. Those four are the bugs to fix, not harness faults.

## The request budget: `tests/hosted-foundation/budget/`

A Vitest test counts D1, Clerk and R2 calls per hosted route through the storage doubles and fails above the budget: a page view
`{ clerk: 0, d1: 1, r2: 1 }`, a PDF range `{ clerk: 0, d1: 0, r2: 1 }`, a mutation `{ clerk: 0, d1: 1 }` (one batch). Run it with
`bun run --bun test tests/hosted-foundation/budget`; [its README](../../../tests/hosted-foundation/budget/README.md) says how a
ticket adds a route (one `<nn>-<slug>.test.ts`, never an edit to the shared files) and what a count leaves out.
`05-existing.test.ts` holds interim budgets for `/cases` and `/cases/[caseId]`, a little above today's counts; tighten them as each
route is rebuilt.
