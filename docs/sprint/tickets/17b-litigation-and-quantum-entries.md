# 17b: Litigation and quantum entries
**Wave:** 2 · **Size:** 1 d · **Security-sensitive:** no · **Suggested agent:** standard (Sonnet / Terra)
## What to build
On staging a lawyer adds their own authorities, heads of argument, cross-examination questions and payments, sets enforcement statuses, keeps the filings register and ticks the information-required checklist, beside the processed content. Saves under 2 seconds, never a silent overwrite; entries survive a reload. The write half of J5's mixed views.

How: 14b's read loaders plus 16's adapter. In `src/lib/views/litigation/writes.server.ts` and `src/lib/views/quantum/writes.server.ts` (and `src/lib/views/evidence/filings.server.ts` for the register actions, `src/lib/views/litigation/register.server.ts` for `orderedRows`/`saveStatus`) take the `Work` implementation as a parameter with the local default, so the same action code runs over `hostedWork(locals, caseId, rv)`. Add `actions` to 14b's hosted routes under the version folder: `litigation/authorities_tab` (`add`), `heads_tab` (`add`, `delete`), `crossexam_tab` (`add`, `delete` of a row or a seed), `enforcement_tab` (`status`), `quantum/payments_tab` (`add`, `delete`), `evidence/filings_tab` (`add`, `save`, `delete` and the seed overlay), `analysis/info_required_tab` (`toggle`); remove the read-only switch 14b passed. `info_required_tab` keys rows by `sha256` of the item text with `node:crypto` (fine under `nodejs_compat`; `crypto` is already on the guard's safe list). Forms carry `operationId` where they lack one (`addId` exists on authorities and heads; add hidden inputs on the local pages for the rest, which you own after 14b). Per-view tests over the D1 user-work double: add, list, delete, stale version, duplicate `operationId`.
## Reserved paths (edit only these; new files under them are fine)
- `deploy/client/routes/cases/[caseId]/v/[version]/litigation/{authorities_tab,heads_tab,crossexam_tab,enforcement_tab}/`
- `deploy/client/routes/cases/[caseId]/v/[version]/quantum/payments_tab/`, `deploy/client/routes/cases/[caseId]/v/[version]/evidence/filings_tab/`, `deploy/client/routes/cases/[caseId]/v/[version]/analysis/info_required_tab/`
- `src/lib/views/litigation/*.server.ts`, `src/lib/views/quantum/writes.server.ts`, `src/lib/views/evidence/filings.server.ts`
- `src/routes/v/[vid]/litigation/`, `src/routes/v/[vid]/quantum/payments_tab/`, `src/routes/v/[vid]/evidence/filings_tab/`, `src/routes/v/[vid]/analysis/info_required_tab/`
- `tests/litigation/17b-*.test.ts`, `tests/quantum/17b-*.test.ts`, `tests/evidence/17b-*.test.ts`, `tests/hosted-foundation/budget/17b-entries.test.ts`
Shared files this ticket owns, which others must not edit until it merges: none.
## Blocked by
- 16 Notes, plus the user-work adapter · 14b Mixed views, read path (both merged into the sprint branch)
## Acceptance
- [ ] On the preview, for each of the seven views: add one synthetic entry, reload, it is listed; delete it where the view allows; each save under 2 s (timings in the PR).
- [ ] An enforcement status change persists and the step shows the new status after reload; an info-required tick persists and unticks.
- [ ] Tests: a save with a stale `version` answers the local conflict message and changes nothing; two posts with one `operationId` create one row; a cross-examination seed deletion writes a seed overlay, not a row delete.
- [ ] Budget (`tests/hosted-foundation/budget/17b-entries.test.ts`): each write is one D1 batch (change plus audit); each page view stays within 14b's read budget.
- [ ] Local actions tests stay green (`tests/litigation`, `tests/quantum`, `tests/evidence/filings-actions.test.ts`).
## Checks (run exactly these; paste the results in the PR)
```
bun install --frozen-lockfile && bunx svelte-kit sync && scripts/agent-tools/doctor
bunx tsc --noEmit -p .
bunx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings
bunx vitest related <changed src files> --run
bun run --bun test tests/litigation tests/quantum tests/evidence src/lib/views tests/hosted-foundation/user-work tests/hosted-foundation/budget
bun run --bun check:hosted-imports && bun run --bun build:hosted
scripts/preview.sh      # add, reload, delete on each of the seven views, note ms
```
## Read first
`research/view-contracts.md` section 1 (the seven rows), 2 (D), 4 (items 7–11); 16's ticket (adapter, `guarded`); 14b's ticket (loaders); `docs/development.md` "Enumerable user-work persistence".
## Decisions already made (don't re-decide)
- Writes only through 16's adapter; the action functions become parameterised over `Work`, with the local default, so local behaviour is unchanged.
- `operationId` from the form; `expected` from the row version; the existing local messages for busy, refused, stale and gone.
- No new tables or migrations: `uw_register_row` and `uw_seed_overlay` carry everything.
## Forbidden
Editing outside the reserved paths; `dev` or `main`; real case material or secrets in Git; new guards, receipts or process files; a second review round; loosening tests; redeploying sandboxes A or B; editing the adapter or `answer.server.ts` (16's, merged: request changes on the issue), `src/lib/views/registers` (17a's), `src/lib/views/bundles` (18's), the builder (06's), `payloads/*` (04's).
## Done means
PR merged into sprint/hosted-demo-20261105 with a merge commit; staging deployed at that SHA; the seven add-reload checks pass there; the Linear issue is Done with the merge SHA; Lows go as a `follow-ups:` comment on the issue.
