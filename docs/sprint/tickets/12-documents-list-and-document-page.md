# 12: Documents list and document page
**Wave:** 2 · **Size:** 1 d · **Security-sensitive:** no · **Suggested agent:** standard (Sonnet / Terra)
## What to build
A lawyer browses the documents list on staging with paging and a bundle filter, opens a document and sees its metadata, excerpt, attachments, related documents and the link to its original, with "Original not supplied" where the file is missing and "inside the parent message" for an e-mail attachment. The navigation part of J4 passes on staging in under 2 seconds per page.

How: `research/view-contracts.md` family C and section 4 (items 2, 3, 6); `research/ui-spec.md` sections 4 and 5. Builder module `scripts/publish/shards/doc.ts`: one `doc/<ref>.json` per document (04's `DocShard`: fields, state, attachments with `hasDocument`, children, related, parent, `assetIds`, `mediaType`, `originalState` from the package's assets: `available`, `missing`, `embedded`). Hosted routes under `deploy/client/routes/cases/[caseId]/v/[version]/`: `evidence/documents/+page.server.ts` reads `list/facets.json` and the needed `list/page-<n>.json` pages through the shard reader (no filter: one page; `?bundle=`: the pages from the Cache API, filtered, then 60 per page as locally through `documentsModel`), returning the local `DocumentsModel` shape plus `base`; `doc/[ref]/+page.server.ts` reads `doc/<ref>.json`, makes one `locals.assets.links` call for the own original (none per attachment), derives `OriginalLinks.presentation` from `mediaType`, and returns `notes: []` until 16 adds the notes read and actions; both `+page.svelte` files re-export the local pages through `$local`. Add hooks to the local pages you now own: `data-testid="document-filter"` on the bundle filter, `open-original` on the Open control (`OriginalOpen.svelte` prop passthrough is 10's; use a wrapper element), `original-metadata` around the original block with the three states as visible text. Set `hostedStatus` for `documents` to `ported`; the `doc` route has no registry entry.
## Reserved paths (edit only these; new files under them are fine)
- `deploy/client/routes/cases/[caseId]/v/[version]/evidence/documents/`, `deploy/client/routes/cases/[caseId]/v/[version]/doc/`
- `scripts/publish/shards/doc.ts`
- `src/routes/v/[vid]/evidence/documents/`, `src/routes/v/[vid]/doc/[ref]/+page.svelte` (hooks only; 16 takes the folder next)
- `src/lib/views/evidence/documents.ts`, `src/lib/views/hosted/availability.ts` (the `documents` line only)
- `tests/publication/shards/12-doc.test.ts`, `tests/hosted-foundation/budget/12-documents.test.ts`, `tests/system/12-*.test.ts`
Shared files this ticket owns, which others must not edit until it merges: `src/routes/v/[vid]/doc/[ref]/+page.svelte` (16 is blocked by this ticket).
## Blocked by
- 06 TRACER (merged into the sprint branch)
## Acceptance
- [ ] J4 steps 1–3 on staging: documents list under 2 s with `document-filter` present; a bundle filter narrows to that bundle's 60-row page with a truthful total; opening a document shows the page with `original-metadata` and `open-original`; timings in the PR.
- [ ] Builder: `doc/<ref>.json` exists for every document of the synthetic fixture, matches `DocShard`, and carries `originalState` `missing` for a fixture asset without bytes and `embedded` for an attachment (`tests/publication/shards/12-doc.test.ts`).
- [ ] Document page states on the preview: available (Open and Download), missing ("Original not supplied", no Open), embedded ("inside the parent message" with a link to the parent's document page).
- [ ] Budget (`tests/hosted-foundation/budget/12-documents.test.ts`): the documents page makes at most 1 D1 and 1 R2 cold read without a filter; the document page makes at most 1 D1 beyond authorization (the links call) and 1 R2 read; no per-attachment calls.
- [ ] Attachments, related documents and children render as links that resolve under the hosted base; Back and deep links work.
## Checks (run exactly these; paste the results in the PR)
```
bun install --frozen-lockfile && bunx svelte-kit sync && scripts/agent-tools/doctor
bunx tsc --noEmit -p .
bunx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings
bunx vitest related <changed src files> --run
bun run --bun test tests/publication/shards src/lib/views tests/system tests/hosted-smoke tests/hosted-foundation/budget
bun run --bun check:hosted-imports && bun run --bun build:hosted
scripts/preview.sh      # walk J4 steps 1–3 and the three original states, note ms
```
## Read first
`research/view-contracts.md` section 1 (doc/[ref], evidence/documents), 2 (C), 4 (items 2, 3, 6); `research/ui-spec.md` sections 4, 5; `research/data-path.md` section 5 (embedded attachments); `research/journeys.md` J4 hooks; `docs/development.md` "Document-row read contract".
## Decisions already made (don't re-decide)
- The documents list reads 06's list pages; with a bundle filter it reads the needed pages from the edge cache and pages at 60, keeping the local model and truthful totals. No new shard family for bundles.
- One `doc/<ref>.json` per document, 06's naming; attachments ride in the shard; one `links` call per page.
- Embedded attachments open only their container; `.eml` is sandboxed text, `.msg` downloads (08 delivers; this page only states it).
- Notes on the document page are 16's; return an empty list and no actions here.
- Hooks go on the shared local page so local and hosted match.
## Forbidden
Editing outside the reserved paths; `dev` or `main`; real case material or secrets in Git; new guards, receipts or process files; a second review round; loosening tests; redeploying sandboxes A or B; editing the builder framework, list shards or `payloads.server.ts` (06's), `OriginalOpen.svelte` (10's), `assets.ts` or the viewer (08's), `payloads/*` (04's; add a new file if a type is missing).
## Done means
PR merged into sprint/hosted-demo-20261105 with a merge commit; staging deployed at that SHA; J4 steps 1–3 pass there; the Linear issue is Done with the merge SHA; Lows go as a `follow-ups:` comment on the issue.
