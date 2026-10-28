# 17a: Deadlines and registers
**Wave:** 2 · **Size:** 1 d · **Security-sensitive:** no · **Suggested agent:** standard (Sonnet / Terra)
## What to build
On staging a lawyer adds, edits and deletes deadlines, sees their countdowns, downloads them as a calendar file, and the overview shows an open-deadlines tile; the other six registers (timesheet, disbursements, privilege, POPIA, annotations, transcripts) keep their entries the same way. Saves under 2 seconds, never a silent overwrite. J8 passes on staging.

How: `research/view-contracts.md` family D (registers) and 16's adapter. `src/lib/views/registers/page.server.ts` takes the `Work` implementation as a parameter (local default unchanged) so `listRegister`, `save` and `delete` run over `hostedWork(locals, caseId, rv)`; anchored refs resolve through the adapter's `anchorFor` path and `fingerprints` from the store. Hosted routes under the version folder: `registers/{deadlines_tab,timesheet_tab,disbursements_tab,privilege_tab,popia_tab,annotations_tab,transcriptions_tab}/` with loaders and `save`/`delete` actions through the adapter, wrapper pages re-exporting `$local/registers/<view>/+page.svelte`; `registers/deadlines_tab/ics/+server.ts` streams the `.ics` as locally. Hooks on `RegisterPage.svelte` (yours): `deadline-title`, `deadline-date`, `deadline-note`, `deadline-save`, `deadline-export` (the register def says which fields exist; the testids apply to the deadlines register's title, date and note fields and its save and export controls). Overview tile: edit 06's `src/lib/views/hosted/overview-slots.server.ts` (yours now) to fill the deadlines and unbilled-time slots from the registers through the adapter, in one `listRows` each. Flip the seven `hostedStatus` lines to `ported`.
## Reserved paths (edit only these; new files under them are fine)
- `deploy/client/routes/cases/[caseId]/v/[version]/registers/`
- `src/lib/views/registers/` (all), `src/routes/v/[vid]/registers/`
- `src/lib/views/hosted/overview-slots.server.ts`
- `src/lib/views/hosted/availability.ts` (the seven lines only)
- `tests/registers/17a-*.test.ts`, `tests/hosted-foundation/user-work/17a-*.test.ts`, `tests/hosted-foundation/budget/17a-registers.test.ts`
Shared files this ticket owns, which others must not edit until it merges: `src/lib/views/registers/*`, `overview-slots.server.ts`.
## Blocked by
- 16 Notes, plus the user-work adapter (merged into the sprint branch)
## Acceptance
- [ ] J8 on staging: fill `deadline-title`, `deadline-date`, `deadline-note`, click `deadline-save`, the row shows the exact title; reload, still there; `deadline-export` downloads an `.ics` whose event has that title and date; save under 2 s; timings in the PR.
- [ ] Edit and delete of a deadline work on the preview; a delete with a stale version answers the local conflict message (test with the D1 double).
- [ ] Each of the other six registers saves and lists one synthetic row on the preview (six short Playwright or curl checks).
- [ ] The overview on the preview shows the open-deadlines count in a filled slot after one deadline is saved (`[data-slot="deadlines"][data-slot-status="filled"]`).
- [ ] Budget (`tests/hosted-foundation/budget/17a-registers.test.ts`): a register page makes at most 1 D1 query beyond authorization; a save is one batch; the overview's two register slots add at most 2 queries.
- [ ] Local registers tests stay green (`tests/registers`, `src/routes/v/[vid]/registers/deadlines_tab/ics.test.ts`).
## Checks (run exactly these; paste the results in the PR)
```
bun install --frozen-lockfile && bunx svelte-kit sync && scripts/agent-tools/doctor
bunx tsc --noEmit -p .
bunx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings
bunx vitest related <changed src files> --run
bun run --bun test tests/registers src/lib/views src/routes tests/hosted-foundation/user-work tests/hosted-foundation/budget
bun run --bun check:hosted-imports && bun run --bun build:hosted
scripts/preview.sh      # walk J8 and the six registers, note ms
```
## Read first
`research/view-contracts.md` section 1 (registers row), 2 (D), 4 (items 7, 8); 16's ticket (adapter interface); `research/ui-spec.md` section 17; `research/journeys.md` J8 hooks; `docs/development.md` "Enumerable user-work persistence", "Overview widget slots".
## Decisions already made (don't re-decide)
- Writes go through 16's adapter only; `RegisterPage` keeps its fields, CRUD and `.ics`. No court-day calculator, reminders, owners or Outlook.
- Deadlines are user work and show whether or not results are published.
- The hosted overview slots come from `overview-slots.server.ts`, not from the `import.meta.glob` of local widget loaders.
- `availability.ts`: flip only your seven lines.
## Forbidden
Editing outside the reserved paths; `dev` or `main`; real case material or secrets in Git; new guards, receipts or process files; a second review round; loosening tests; redeploying sandboxes A or B; editing the adapter or `answer.server.ts` (16's, merged: request a change on the issue instead), `src/lib/views/litigation|quantum` (17b's), `src/lib/views/bundles` (18's), `app.css` and components (10's).
## Done means
PR merged into sprint/hosted-demo-20261105 with a merge commit; staging deployed at that SHA; J8 passes there; the Linear issue is Done with the merge SHA; Lows go as a `follow-ups:` comment on the issue.
