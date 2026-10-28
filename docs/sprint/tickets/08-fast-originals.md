# 08: Fast originals
**Wave:** 1 · **Size:** 1–1.5 d · **Security-sensitive:** yes · **Suggested agent:** strong (Opus / Sol)
## What to build
A lawyer opens any original and sees its first PDF page in under 3 seconds whatever the size; a 633-byte PDF in under 1.5 seconds. The viewer page authorizes once and mints a short-lived asset ticket; pdf.js range requests present the ticket and cost no database query. Bytes stream from storage as ranged reads conditional on the stored tag, with no hashing on read. Every read is still audited, after the response. Downloads of files over 100 MB redirect to a short-lived presigned storage URL. E-mails and images open inline where the family allows; other formats download; a missing original says "Original not supplied".

How: `architecture.md` section 1 "Originals" and `research/data-path.md` section 5. In `src/lib/results/hosted/assets.ts` replace the buffered read with `bucket.get(key, { range, onlyIf: { etagMatches: row.etag } })` streamed, using `size`, `etag`, `media_family` and `media_type` from the one D1 row (`rs_case_original` join `rs_original`); a `412`/`changed` answer when the tag moved; the `record()` audit write moves into `waitUntil` from `cloudflare:workers`. `src/lib/storage/cloud/objects.ts` gains `rangedRead` beside `verifiedRead` (keep the old function for the operator paths). `src/lib/viewer/hosted/ticket.ts`: HMAC-SHA256 (WebCrypto) over `{ caseId, assetId, sha256, etag, size, mediaType, subject, exp }` with `exp` = now + 15 min, key from the secret `CLEARCASE_ASSET_TICKET_KEY` (`env` from `cloudflare:workers`, as `sign-in/+page.server.ts` reads env); the view page (`originals/[assetId]/view/+page.server.ts`) does the 1-D1 authorization and passes `?t=<ticket>` to the viewer, which appends it to every range request; `originals/[assetId]/+server.ts` with a valid ticket skips identity and grant and reads R2 with the ticket's etag (0 D1); without one it authorizes as today. `delivery.ts` picks inline/download/sandboxed from `media_family`, drops the 1 KiB probe read and the second full read, keeps the sandbox CSP. Presigned URL: hand-written SigV4 query signing with WebCrypto (no new package) using secrets `R2_S3_ACCESS_KEY_ID`, `R2_S3_SECRET_ACCESS_KEY` and the EU endpoint; `?download=1` on an object over 100 MB answers 302 to a URL valid 10 minutes. Make the viewer HTML and the first bytes load in parallel: the view page carries the ticket and metadata, so pdf.js starts its first range immediately. Add `data-testid="pdf-page"` with `data-page-number` and `data-rendered="true"` only after the first canvas draw (`PdfViewer.svelte`).
## Reserved paths (edit only these; new files under them are fine)
- `src/lib/results/hosted/{assets.ts,index.ts}`, `src/lib/storage/cloud/{objects.ts,original-facts.ts}`
- `src/lib/viewer/hosted/` (all files; new `ticket.ts`, `presign.ts`)
- `deploy/client/routes/cases/[caseId]/originals/`
- `tests/hosted-smoke/originals/`, `tests/hosted-foundation/storage/08-*.test.ts`, `tests/hosted-foundation/budget/08-originals.test.ts`
Shared files this ticket owns, which others must not edit until it merges: `assets.ts`, `objects.ts`, everything under `viewer/hosted/`.
## Blocked by
- 02 Staging environment · 05 Journeys and request budget · 07 v5 originals on staging (merged into the sprint branch: the `etag` and `media_family` columns and the large files)
## Acceptance
- [ ] J4 step 4 on staging, three size bands: the 633-byte-class PDF renders `pdf-page[data-page-number="1"][data-rendered="true"]` in under 1.5 s, the median PDF under 2 s, the 258 MB PDF under 3 s, measured from the owner's network and recorded in the PR with the SHA.
- [ ] Budget (`tests/hosted-foundation/budget/08-originals.test.ts`): the view page makes 1 D1 query and 0 R2 reads; a ranged GET with a valid ticket makes 0 D1 queries and 1 R2 read; a GET without a ticket makes 1 D1 and 1 R2; no code path hashes the body (no `DigestStream`, no `crypto.subtle.digest` over object bytes).
- [ ] Security tests (`tests/hosted-smoke/originals/`): an expired ticket, a ticket for another case or asset id, a ticket signed with another key, and a ticket presented after the grant was revoked but before expiry (allowed, documented as the 15-minute window) behave as specified; a wrong-case asset URL answers 404 without an R2 read; the presigned URL expires after 10 minutes and names only the one object.
- [ ] A changed object (etag mismatch) answers 412 with no bytes; the audit row for every served read is written after the response (asserted through the audit double's call order).
- [ ] `.eml` opens sandboxed text, JPEG inline, `.msg` and Word download; an asset with no stored bytes shows "Original not supplied" on the document page's `original-metadata` block (12 renders the page; this ticket supplies the state).
## Checks (run exactly these; paste the results in the PR)
```
bun install --frozen-lockfile && bunx svelte-kit sync && scripts/agent-tools/doctor
bunx tsc --noEmit -p .
bunx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings
bunx vitest related <changed src files> --run
bun run --bun test tests/hosted-smoke tests/hosted-foundation/storage tests/hosted-foundation/runtime tests/hosted-foundation/budget
bun run --bun check:hosted-imports && bun run --bun build:hosted
scripts/preview.sh      # open the three bands on the preview, note first-page ms
```
## Read first
`architecture.md` section 1 (Originals, request budget); `research/data-path.md` section 5; `research/journeys.md` (Documents/PDF hooks); `docs/development.md` "Hosted runtime"; ADR 0011; the four hosted review classes in `AGENTS.md` sprint block.
## Decisions already made (don't re-decide)
- Integrity on read is the etag match against `rs_original.etag`; no whole-object hash in the Worker, ever. Tag mismatch is 412, not a fallback read.
- Ticket: HMAC-SHA256, 15 minutes, bound to case, asset, sha256, etag, size, media type and subject; carried as `?t=`; never in a log or error body. Revocation inside the window is accepted (owner decision, about a minute for sessions; 15 minutes for tickets).
- Presigned URLs only for `?download=1` on objects over 100 MB, 10-minute expiry, S3 endpoint only; in-app PDF viewing stays same-origin behind the Worker so the sandbox CSP applies.
- Media family comes from the D1 row written by 07; nothing probes bytes.
- Audit of reads is one row per request in `waitUntil`; audit of mutations stays fail-closed (09b).
- The sign-in and session path is 09a's; this ticket only needs `locals.identity` as today. `services.ts` and `contracts.ts` are 06's: read secrets through `env` from `cloudflare:workers` inside `viewer/hosted/`.
- Secrets `CLEARCASE_ASSET_TICKET_KEY` (generated by the builder with `openssl rand -hex 32`, put on staging and the preview base-config) and the R2 S3 pair (the owner's token from 02) are put with `wrangler secret put`; names only in the PR.
## Forbidden
Editing outside the reserved paths; `dev` or `main`; real case material or secrets in Git; new guards, receipts or process files; a second review round; loosening tests (the existing `tests/hosted-smoke/native-viewer` and `gate-original-route-denials` stay green and unchanged); redeploying sandboxes A or B; adding a package to the hosted graph; editing `services.ts`, `contracts.ts` (06's), `tenancy/`, `audit/` (09b's), `auth/` (09a's).
## Done means
PR merged into sprint/hosted-demo-20261105 with a merge commit; staging deployed at that SHA; J4 step 4 passes at all three bands on staging; the Linear issue is Done with the merge SHA; Lows go as a `follow-ups:` comment on the issue.
