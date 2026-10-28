# 16: Notes, plus the user-work adapter
**Wave:** 2 · **Size:** 1 d · **Security-sensitive:** no · **Suggested agent:** strong (Opus / Sol)
## What to build
A lawyer adds a note to a document on staging, sees it after a reload, finds its text in the case's notes list, and the overview tile counts it; saves finish in under 2 seconds and never silently overwrite a colleague's change. J7 passes on staging. One adapter gives every local form action the hosted store's semantics, so 17a, 17b and 18 wire their actions by changing an import.

How: P4 in `research/view-contracts.md` section 5 and section 4 items 6–10. `src/lib/views/hosted/work-adapter.server.ts`: `hostedWork(locals, caseId, rv): Work` wrapping `AsyncUserWork` into the local `Work` shape (`listRows`, `putRow`, `deleteRow`, `seedViews`, `putSeedOverlay`, `notesFor`, `addNote`, `deleteNote`, `listTableRows`, `putTableRow`): `expected` from the form's `version` field (absent means `absent`), `operationId` from the form's `addId` or `crypto.randomUUID()`, anchors through `anchorFor`; a hosted `guarded` that maps `Written` stale/gone and `ContractError` codes onto the existing `Answer` shape (`retry`, `gone`, `message`) so the local pages' error handling works unchanged. In `src/lib/local-case/answer.server.ts` export the `Work` interface and make `guarded` take the work implementation (local callers unchanged by default). Document notes: `deploy/client/routes/cases/[caseId]/v/[version]/doc/[ref]/+page.server.ts` (12's loader, now yours) reads `notesFor` for the document anchor and exports `note` and `delnote` actions through the adapter; the local page's note form (`src/routes/v/[vid]/doc/[ref]/+page.svelte`) gets a hidden `operationId` input, `data-testid="note-body"` on the textarea and `note-add` on the button, and shows saved notes with body and date. Case notes list: `deploy/client/routes/cases/[caseId]/notes/` shows every note's body, document reference and date with `data-testid="case-notes-list"` (today it shows refs only). Cap the cost of the overview's notes summary: one `notesFor({caseId, target: null})` and no per-note `resolve` (view-contracts D). Flip nothing in `availability.ts` (doc has no registry entry).
## Reserved paths (edit only these; new files under them are fine)
- `src/lib/views/hosted/{work-adapter.server.ts,notes.server.ts,NoteText.svelte}`, `src/lib/local-case/answer.server.ts`, `src/lib/local-case/answer.test.ts`, `src/lib/user-work/registers.server.ts`
- `deploy/client/routes/cases/[caseId]/v/[version]/doc/[ref]/`, `deploy/client/routes/cases/[caseId]/notes/`
- `src/routes/v/[vid]/doc/[ref]/`
- `tests/hosted-foundation/user-work/16-*.test.ts`, `tests/hosted-smoke/case-overview/16-*.test.ts`, `tests/hosted-foundation/budget/16-notes.test.ts`
Shared files this ticket owns, which others must not edit until it merges: `work-adapter.server.ts`, `answer.server.ts` (17a, 17b and 18 are blocked by this ticket).
## Blocked by
- 12 Documents list and document page (merged into the sprint branch)
## Acceptance
- [ ] J7 on staging: open a document, type in `note-body`, click `note-add`, the note shows with its body; reload, still there; `/cases/v5-demo/notes` shows `case-notes-list` containing that body; save under 2 s; timings in the PR.
- [ ] Concurrency: two saves with the same `operationId` produce one note; a delete with a stale `version` answers the local "changed by someone else" message, not a silent overwrite (tests with the D1 user-work double).
- [ ] Adapter tests: every `Work` method maps to the hosted store and back for the synthetic case; `guarded` returns `retry` on busy, `gone` on gone, the refused message on a contract error.
- [ ] Budget (`tests/hosted-foundation/budget/16-notes.test.ts`): a note save is one D1 batch (the change and its audit together); the document page with notes makes at most 2 D1 queries beyond authorization (links, notes); the overview notes summary makes 1.
- [ ] Local note saves still work and the local J7 document-note steps pass; the case-wide list shows bodies locally too if the local notes route exists, otherwise it is a Low.
## Checks (run exactly these; paste the results in the PR)
```
bun install --frozen-lockfile && bunx svelte-kit sync && scripts/agent-tools/doctor
bunx tsc --noEmit -p .
bunx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings
bunx vitest related <changed src files> --run
bun run --bun test src/lib/local-case tests/hosted-foundation/user-work tests/hosted-smoke/case-overview tests/registers tests/hosted-foundation/budget
bun run --bun check:hosted-imports && bun run --bun build:hosted
scripts/preview.sh      # walk J7, note ms
```
## Read first
`research/view-contracts.md` sections 2 (D), 4 (items 6–10), 5 (P4); `docs/development.md` "Enumerable user-work persistence"; `src/lib/user-work/hosted/d1-user-work.ts`; `src/lib/local-case/answer.server.ts`; `research/ui-spec.md` section 16; `research/journeys.md` J7 hooks.
## Decisions already made (don't re-decide)
- One adapter, in `src/lib/views/hosted/`, over the existing hosted user-work store; no second store, no schema change (the `uw_*` tables suffice).
- `operationId` comes from the form (`addId` or a hidden field) and `expected` from the row's `version`; stale and gone answer with the existing local messages.
- Notes anchor on document fingerprints from the `rs_document` rows 06 writes; `HostedNote` fields missing from `NoteView` (`refAtCreation`, `resultsVersion`, `anchorSha256`) are filled from the anchor and version in the adapter.
- Audit of a change rides in the same batch (09b's sink); the adapter calls the store, never D1 directly.
- Case notes list lives at `/cases/<caseId>/notes` (existing route) and shows bodies.
## Forbidden
Editing outside the reserved paths; `dev` or `main`; real case material or secrets in Git; new guards, receipts or process files; a second review round; loosening tests; redeploying sandboxes A or B; editing `d1-user-work.ts` (its contract is the seam), `contracts.ts`, `services.ts` (09b's), the registers pages (17a's), `writes.server.ts` files (17b's), `OriginalOpen`/components (10's).
## Done means
PR merged into sprint/hosted-demo-20261105 with a merge commit; staging deployed at that SHA; J7 passes there; the Linear issue is Done with the merge SHA; Lows go as a `follow-ups:` comment on the issue.
