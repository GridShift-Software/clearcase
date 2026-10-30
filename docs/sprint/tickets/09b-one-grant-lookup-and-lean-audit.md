# 09b: One grant lookup and lean audit
**Wave:** 1 · **Size:** 1 d · **Security-sensitive:** yes · **Suggested agent:** strong (Opus / Sol)
## What to build
Every hosted page view costs at most one database query and no Clerk call: the grant check, the case, and the published version come back together. Reads are still audited, one row per request, written after the response with no read-back. Changes are audited in the same database batch as the change and fail closed. The budget test shows it.

How: `architecture.md` section 1 (request budget, "Audit without read-back") and `research/view-contracts.md` section 3. In `src/lib/tenancy/d1-grants.ts` add one statement that returns the live grant for `(client_id, issuer, subject, case_id)` joined with `rs_case` and `rs_publication` (`version_id`, `published_at`, `previous_version_id`), using the existing `tenant_case_grants_principal` index; add migration `0004_tenant_grant_lookup.sql` (staging `0010`) only if `EXPLAIN QUERY PLAN` shows a scan. In `src/lib/tenancy/authorizer.ts` drop the second grant read and the `exists` round trip; authorization memoises its result per request. `src/lib/views/hosted/case.server.ts`: `readCase` does that one lookup and caches `{ caseId, info, published }` on `locals` (a `WeakMap` keyed by the request or a field 06's `services.ts` exposes, which you may now edit); `requireCurrent` and `CaseReader.publication()` (06's method) read the memo and make no query. `src/lib/audit/d1-log.ts`: read audits become one `INSERT` in `waitUntil`, no `SELECT` back and no counter reads; change audits are appended to the caller's `db.batch` through the existing sink interface so the change and its audit commit together, and a failed audit fails the change (`tests/hosted-foundation/audit` proves both). Upload-grant and operator paths keep their existing checks. Record the page-view counts before and after in the PR.
## Reserved paths (edit only these; new files under them are fine)
- `src/lib/tenancy/` (including `migrations/0004_tenant_grant_lookup.sql`), `src/lib/audit/`
- `src/lib/views/hosted/case.server.ts`, `src/lib/results/hosted/versions.ts`
- `src/lib/server/runtime/{contracts.ts,memory.ts}`, `src/lib/server/runtime/hosted/services.ts` (after 06 merged; additive changes only)
- `deploy/staging/migrations/0010_tenant_grant_lookup.sql`
- `tests/hosted-foundation/{audit,upload-grant,case-grant-provisioning,provisioning}/`, `tests/hosted-foundation/budget/09b-page-budget.test.ts`
Shared files this ticket owns, which others must not edit until it merges: `case.server.ts`, `contracts.ts`, `services.ts`.
## Blocked by
- 02 Staging environment · 05 Journeys and request budget · 06 TRACER (merged into the sprint branch: `contracts.ts`, `services.ts` and `publication()` exist)
## Acceptance
- [ ] Budget (`tests/hosted-foundation/budget/09b-page-budget.test.ts`): the hosted overview and a `[category]/[view]` page view make exactly 1 D1 query (`prepare` or `batch` count), 0 Clerk calls, at most 1 R2 read; the view page for an original makes 1 D1 query; the counts before this ticket are in the PR body.
- [ ] A user with no grant for the case gets 404 or 403 after 1 D1 query and no R2 read; a user of another client (different `client_id`) the same; a revoked grant the same (tests under `tests/hosted-foundation/upload-grant` and a new `tenancy` test).
- [ ] Read audit: the row for a page view is written after the response (call-order assertion through the audit double) and a failing audit write does not fail the read. Change audit: a note save with a failing audit insert leaves no note row (`tests/hosted-foundation/audit`).
- [ ] J1 steps 2–4 and J2 still pass on staging; overview TTFB from the owner's network recorded before and after.
- [ ] Existing suites `tests/hosted-foundation/{identity,audit,upload-grant,user-work}` and `tests/hosted-smoke` green at the head.
## Checks (run exactly these; paste the results in the PR)
```
bun install --frozen-lockfile && bunx svelte-kit sync && scripts/agent-tools/doctor
bunx tsc --noEmit -p .
bunx vitest related <changed src files> --run
bun run --bun test tests/hosted-foundation/audit tests/hosted-foundation/upload-grant tests/hosted-foundation/identity tests/hosted-foundation/user-work tests/hosted-foundation/budget tests/hosted-smoke
bun run --bun check:hosted-imports && bun run --bun build:hosted
scripts/preview.sh      # overview, a coming-soon view, an original view page; note ms
```
## Read first
`architecture.md` section 1; `research/view-contracts.md` sections 3 and 4 (items 1, 4, 5); `src/lib/tenancy/migrations/0001_tenant_case_grants.sql` (indexes); `docs/hosted-foundation/identity.md` (grants); the four hosted review classes in the `AGENTS.md` sprint block.
## Decisions already made (don't re-decide)
- Budget per page view: 0 Clerk, at most 1 D1, at most 1 R2. The single statement joins grant, case and publication; the published pointer stays in D1 (no KV pointer).
- Read audit after the response in `waitUntil`, no read-back, never fail-closed. Change audit in the same batch, fail-closed. No audit counters on the request path.
- Grant model unchanged: per-case, explicit, revocable; roles and upload grants as today. No grant caching across requests.
- `publishedAt` for the version pill flows through `readCase`'s memo to 06's `CaseReader.publication()`.
- The session and Clerk path is 09a's; keep the authorizer interface so both merge cleanly. If 09a merges first, rebase nothing: merge the sprint branch in.
- Security review: one agent of the other model family, four classes, at most 3 probes.
## Forbidden
Editing outside the reserved paths; `dev` or `main`; real case material or secrets in Git; new guards, receipts or process files; a second review round; loosening or deleting any tenancy, audit or grant test; redeploying sandboxes A or B; editing `auth/`, `hooks.server.ts`, `handle.ts` (09a's), `assets.ts`, `viewer/hosted` (08's), the version layout or `payloads.server.ts` (06's, except through `readCase`).
## Done means
PR merged into sprint/hosted-demo-20261105 with a merge commit; staging deployed at that SHA; the budget test passes at the spec's numbers and J2 passes on staging; the Linear issue is Done with the merge SHA; Lows go as a `follow-ups:` comment on the issue.
