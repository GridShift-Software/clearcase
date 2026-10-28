# 09a: App session and revocation
**Wave:** 1 · **Size:** 1 d · **Security-sensitive:** yes · **Suggested agent:** strong (Opus / Sol)
## What to build
A lawyer signs in with e-mail and code in under 5 seconds and stays signed in for the working day: 8 hours sliding, 24 hours at most, through long PDF reading and a 20-minute idle, with no 401 or 503. Clerk is consulted only at sign-in and sign-out. Signing out ends access on every device within about a minute. No page view calls Clerk.

How: `architecture.md` section 1 "Authorize once, verify locally" and "Sessions that survive long tasks". At sign-in (`deploy/client/routes/sign-in/`), verify Clerk's session JWT networklessly with the existing `CLERK_CLIENT_JWT_KEY` (`verifyToken` with `jwtKey`, `authorizedParties` = `CLEARCASE_APP_ORIGIN`), then issue the app session: `src/lib/auth/app-session.ts` mints an HttpOnly, Secure, SameSite=Lax cookie `clearcase_session` carrying `{ sid, subject, issuer, principalKind, name, iat, exp, max }` signed with HMAC-SHA256 under the secret `CLEARCASE_SESSION_KEY`; `exp` slides by 8 hours on each request that is more than 5 minutes after the last refresh (re-set the cookie), never past `iat + 24 h`. The identity provider (`src/lib/auth/clerk/provider.ts`, keeping the `IdentityProvider` interface `services.ts` already consumes) authenticates from the app cookie and checks one KV key `revoked:<sid>` in `env.SESSIONS` (binding added to `src/lib/server/runtime/hosted/bindings.ts`); it no longer calls `sessionStands` on reads. Sign-out (`deploy/client/routes/sign-out/`) writes `revoked:<sid>` with TTL = remaining `max`, clears the cookie and then sends the Clerk sign-out. The handle (`hosted/handle.ts`, `hooks.server.ts`) drops the 60-second Clerk refresh dance (`refreshFor`, `REAUTH_HEADER` paths) for client principals; the staff path keeps its current flow unless it falls out for free. Show the user's name from the cookie in the shell's `account` field (the layout, 06's, reads `locals.identity`; expose `name` on the identity state). Tests for expiry, sliding, the 24-hour cap, revocation, cross-client issuer refusal, cookie attributes and "no Clerk call on a page view".
## Reserved paths (edit only these; new files under them are fine)
- `src/lib/auth/` (all)
- `src/lib/server/runtime/hosted/{hooks.server.ts,handle.ts,session.ts,bindings.ts,origin-guard.ts}`, `src/lib/server/runtime/hosted/gate/{identity.ts,hooks.server.ts}`
- `deploy/client/routes/sign-in/`, `deploy/client/routes/sign-out/`
- `tests/hosted-foundation/identity/`, `tests/hosted-smoke/auth-routing/`, `tests/hosting-probe/identity/`, `tests/hosted-foundation/budget/09a-session.test.ts`
Shared files this ticket owns, which others must not edit until it merges: `hooks.server.ts`, `handle.ts`, `bindings.ts`.
## Blocked by
- 02 Staging environment · 05 Journeys and request budget (merged into the sprint branch; the KV namespace and Clerk staging application exist)
## Acceptance
- [ ] Sign-in on staging from a fresh browser completes to the case list in under 5 s, at most 2 Clerk hops (J1 step 1 timing, recorded with the SHA).
- [ ] J10 on staging with `IDLE_MINUTES=20`: no 401 or 503 across idle, navigate, note save (or read, before 16) and reload.
- [ ] Budget (`tests/hosted-foundation/budget/09a-session.test.ts`): a page view with a valid app cookie makes 0 Clerk fetches and at most 1 KV read; the identity double proves no network call.
- [ ] Tests: a cookie 8 h 1 min after its last refresh is refused; a cookie refreshed within the window slides; no cookie lives past 24 h from issue; after sign-out the same cookie is refused on the next request to any Worker sharing the KV (revocation read); a cookie signed for another client id or issuer is refused; `Set-Cookie` carries `HttpOnly; Secure; SameSite=Lax; Path=/`.
- [ ] Revocation lag on staging measured and recorded (sign out in one browser, request in another; expected under about a minute).
- [ ] No token, cookie value or ticket appears in logs, error bodies, the PR or the receipts (grep the test output).
## Checks (run exactly these; paste the results in the PR)
```
bun install --frozen-lockfile && bunx svelte-kit sync && scripts/agent-tools/doctor
(cd tests/hosting-probe/identity && bun install --frozen-lockfile)
bunx tsc --noEmit -p .
bunx svelte-check --tsconfig ./tsconfig.json --fail-on-warnings
bunx vitest related <changed src files> --run
bun run --bun test tests/hosted-foundation/identity tests/hosted-smoke/auth-routing tests/hosted-foundation/runtime tests/hosted-foundation/budget tests/hosting-probe/identity
bun run --bun check:hosted-imports && bun run --bun build:hosted
scripts/preview.sh      # sign in, idle 20 min, reload; note ms and status codes
```
## Read first
`architecture.md` section 1; `docs/hosted-foundation/identity.md`; ADR 0007; `research/cloudflare-ops.md` section 2 (Clerk facts); `research/journeys.md` J10; the four hosted review classes in the `AGENTS.md` sprint block; memory note `form-action-redirect-chain` applies to the sign-in redirect chain (real Chromium proof).
## Decisions already made (don't re-decide)
- Clerk only at sign-in and sign-out. The app session is ours: HMAC cookie, 8 h sliding, 24 h cap. Revocation is the KV key `revoked:<sid>`; the owner accepts about a minute of lag.
- The KV binding is `SESSIONS` on `clearcase-staging-sessions` (02 created it and bound it in `deploy/staging/wrangler.jsonc` and the previews block). The secret is `CLEARCASE_SESSION_KEY` (`openssl rand -hex 32`, put on staging and the preview base-config by the builder; name only in the PR).
- `services.ts` and `contracts.ts` are 06's: the provider reads `env.SESSIONS` from the env it already receives through `clerkIdentityProviderFromEnv`. Do not add a KV service to `RequestServices`.
- The grant lookup and audit shape are 09b's; this ticket keeps the authorizer interface.
- Existing identity, tenancy and audit suites stay green; new tests are added, none removed.
- Security review: one agent of the other model family, four classes, at most 3 probes, counts as the one review.
## Forbidden
Editing outside the reserved paths; `dev` or `main`; real case material or secrets in Git; new guards, receipts or process files; a second review round; loosening or deleting any identity, revocation or sign-in test; redeploying sandboxes A or B; production Clerk keys; editing `services.ts`, `contracts.ts` (06's), `tenancy/`, `audit/` (09b's), `viewer/hosted/` (08's).
## Done means
PR merged into sprint/hosted-demo-20261105 with a merge commit; staging deployed at that SHA; J1 step 1 under 5 s and J10 pass on staging; the Linear issue is Done with the merge SHA; Lows go as a `follow-ups:` comment on the issue.
