# Hosted identity: the Clerk IdentityProvider (GRS-113)

Status: PREPARED, UNVERIFIED. Unit tests use synthetic keys and a loopback session lookup. They are evidence for this adapter only. No real Clerk instance, Cloudflare resource or browser has exercised it.

The hosted client deployment authenticates with Clerk ([ADR-0007](../adr/0007-hosted-client-isolation-and-identity.md), [ADR-0008](../adr/0008-workers-runtime-and-cloudflare-first-stack.md)). Each deployment trusts two separate Clerk applications: its own client instance, for the firm's users, and the internal staff instance, for operators and the Global Admin. Clerk holds identities and sessions only. A case decision belongs to the case-grant and audit owner (GRS-114), whose data lives outside Clerk.

## Modules

| Module | What it is | Imports the SDK |
| --- | --- | --- |
| `src/lib/auth/clerk/config.ts` | `readClerkIdentityConfig(env)` and `clerkSignInTarget(env, returnTo, kind)`: pure, no network, no secret in any result | no |
| `src/lib/auth/clerk/provider.ts` | `clerkIdentityProviderFromEnv(env, { authorizeCase })` and `createClerkIdentityProvider`: the `IdentityProvider` of `runtime/contracts.ts`, plus `signOut` | `@clerk/backend` 3.26.0 (exact pin) |
| `src/lib/auth/clerk/session.ts` | cookie names, `presentedToken` (the one credential rule) and `inspectToken` (the token shape gate), for routes and the provider | no |
| `src/lib/auth/clerk/flow.ts` | the browser flow the routes call: `planSignIn`, `prepareSignIn`, `safeReturnTo`, `clerkCookieClears`, `signOutClerkSession`, `revokeClerkSession`, `revokeOwnedSession`, `handshakeResponse` | no |
| `src/lib/auth/clerk/revocation.ts` | `revocationEvidenceOf`: the revoke-only evidence of an expired session token (below). Not an Identity, with no authentication use | no (WebCrypto) |
| `src/lib/auth/clerk/browser.ts` | the hook-level handshake: `clerkBrowserHandshakeFromEnv(env)` returns `{ handshake }` whose `handle(request)` is `@clerk/backend`'s `authenticateRequest`, narrowed (below); re-exports `flow.ts` | `@clerk/backend` |

The hosted import allowlist keeps `@clerk/backend` out of routes, so routes import `config.ts`, `session.ts` and `flow.ts` only (`flow.ts` reaches `revocation.ts`). `provider.ts` and `browser.ts` are for the coordinator's composition.

## Configuration

Every value comes from the Worker env, never from a request. Any missing or malformed value makes the whole configuration unavailable. The reason names variables, never values.

| Variable | Kind | Rule |
| --- | --- | --- |
| `CLEARCASE_CLIENT_ID` | var | the one client this deployment serves (same variable as `bindings.ts`) |
| `CLEARCASE_APP_ORIGIN` | var | this deployment's origin; the only authorized party (`azp`) a token may name; https, or http on loopback |
| `CLERK_CLIENT_PUBLISHABLE_KEY`, `CLERK_CLIENT_SECRET_KEY` | var, secret | the client instance; its issuer is `https://` plus the host the publishable key names |
| `CLERK_CLIENT_JWT_KEY` | secret, **required** | the instance's RSA-2048 public key (PEM, `e` 65537; newlines optional), the exact form `@clerk/backend` 3.26.0 loads. Any other key (EC, another RSA size) makes the configuration unavailable |
| `CLERK_STAFF_PUBLISHABLE_KEY`, `CLERK_STAFF_SECRET_KEY`, `CLERK_STAFF_JWT_KEY` | as above | the staff instance; it must be a different application (issuer, publishable key and secret key all differ) |
| `CLERK_SESSION_AUDIENCE` | var, optional | when set, a token must carry exactly this `aud` (Clerk session tokens carry none by default; `azp` is the audience stand-in) |
| `CLERK_STAFF_SIGN_IN_URL` | var, optional | the staff instance's sign-in page for `/sign-in/operator`; without it that route stays 503 |
| `CLERK_API_URL` | var, optional | Backend API base; https, or http on loopback (tests) |
| `CLERK_CLIENT_SIGN_IN_URL` | var, optional | the client instance's sign-in page that `/sign-in` links to; without it `/sign-in` stays 503 |
| `AUTH_MFA_REQUIRED` | var, optional | `"true"` requires a second factor (`fva`); absent or `"false"` is off (ADR-0008: initially off) |

## What one request goes through

1. One credential: a Bearer token, or a session cookie (`__session` or a suffixed `__session_<id>`), or several only when they carry the same token. None is `unauthenticated`. A repeated name, differing values, a quoted value or a comma-joined `Cookie` header is `invalid-session` (never a silent miss).
2. The token shape gate (`inspectToken`): three base64url parts, a plain-object header with `alg` exactly `RS256`, `typ` absent or `JWT`, no `jku`, `x5u`, `x5c`, `jwk` or `crit`, a plain-object payload with correctly typed claims. A token that fails is `invalid-session` and never reaches the SDK.
3. `verifyToken` from `@clerk/backend` against the client instance, then the staff instance, **with the instance's configured key only**. It checks the signature, `exp`, `nbf`, `iat`, the instance's exact issuer, this origin as the only authorized party and, when configured, the audience. Every SDK reason is a token verdict (401) except the key and JWKS faults (503). The configured keys are imported once per provider; a key that cannot be imported makes every request unavailable (a configuration fault), never a verdict on a token.
4. Our own claim checks, because the SDK tolerates some missing claims: `sub` and `sid` present, `azp` present and equal to the origin, `aud` present and equal when one is configured, `sts` (when present) `active`, and a second factor when the MFA flag is on.
5. The session's current status from the issuing instance's Backend API: `active` and owned by `sub`. `checkRevocation()` and every `authorize()` repeat this lookup, so a revoked session is refused while its token is unexpired.

A refused credential yields an anonymous identity whose checks throw the refusal (401 through `refuse`). Only a fault that is not the caller's throws `identity-unavailable` (retryable) from `authenticate`: a key that cannot be imported, or a failed status lookup other than 404. No Clerk metadata, role or claim grants anything.

### No JWKS, no request per token

Both JWT keys are required, so verification never calls Clerk: an unauthenticated token with an unknown `kid` (or any other shape) causes no Backend API or JWKS request, and the 25-token random-kid burst test asserts zero. The PEM carries no `kid`, so the key is the only trust anchor. **Key rotation** is an operator action: put the new instance public key in `CLERK_*_JWT_KEY` and redeploy; until then tokens signed by the new key are refused (401). A missing or malformed key makes the deployment unconfigured (`ready:false`, 503 naming the variable), and nothing falls back to a JWKS fetch. The only Backend API calls left are the authenticated session-status lookup and sign-out revocation, one per verified request or check, plus, at sign-out or a cross-kind sign-in with an expired but genuinely signed token, one ownership lookup and one revoke (never before a signature verified, so an unauthenticated token still causes none); that rate exposure is unmeasured.

## The handshake with GRS-114

```ts
export type CaseAuthorizer = (a: { principal: Principal; sessionId: SessionId; caseId: CaseId; operation: CaseOperation }) => Promise<void>;
```

`identity.authorize({ caseId, operation })` first rechecks the session, then calls `authorizeCase` with the contract's `Principal` (`issuer`, `subject`, `kind: 'client' | 'staff'`) and `SessionId`. Resolving allows. A thrown contract error (for example `forbidden`) stands. Any other throw becomes `identity-unavailable`, never an allow. The factory refuses to build without an authorizer. A staff, Global Admin or firm admin principal reaches a case only when the authorizer allows it.

## How the composer wires it (coordinator)

`hosted/services.ts` is reserved to the coordinator. The intended composition, per request:

```ts
import { clerkIdentityProviderFromEnv } from '$lib/auth/clerk/provider';
const made = clerkIdentityProviderFromEnv(env, { authorizeCase }); // GRS-114's authorizer; deny-all until it lands
if (!made.ok) return { ready: false, reason: made.reason, services };
try {
	services.identity = await made.provider.authenticate({ request });
} catch {
	return { ready: false, reason: 'the identity provider is unavailable', services };
}
```

`tests/hosted-foundation/identity/production-entry.test.ts` drives the production entry this way. It stays red until this composition lands.

Shared changes the composition needs, all outside this ticket's writes:

- `scripts/ci/hosted-imports.ts` (and the artifact scan, if it lists packages) must allow `@clerk/backend` once `services.ts` imports the provider.
- `vitest.config.ts` must include `tests/hosted-foundation/identity/**/*.test.ts`. Until then, run `bun run --bun vitest run -c tests/hosted-foundation/identity/vitest.config.ts`.
- `wrangler.toml` and the secrets need the variables above. The Worker reaches the Clerk Backend API (`api.clerk.com`) for session status and sign-out revocation.

## The first-party browser flow (contract only, UNWIRED)

Sign-in is by invitation, at Clerk. The page links nowhere on its own: `/sign-in` is a form whose action runs the identity switch and then sends the browser (303) to the client instance's sign-in page with `redirect_url` set to a same-origin path (`safeReturnTo`: a path under this origin, never absolute, protocol-relative, backslashed or `/sign-out`; default `/cases`). Staff use `/sign-in/operator`, the per-client operator route on this same origin and Worker, which targets `CLERK_STAFF_SIGN_IN_URL`. There is no staff host and no third Worker. The hosted-gate profile has no operator sign-in (404).

**Handshake (the hook calls it).** `clerkBrowserHandshakeFromEnv(env)` gives `handshake.handle(request)`, which returns `continue`, a `redirect` (303 to `location`, with `setCookies`) or a `refuse`. `handshakeResponse(outcome)` turns it into a `Response`, or `null` to continue. It runs `authenticateRequest` of `@clerk/backend` with only the browser's cookie and document hints, for this origin only, and:

- redirects to the picked instance's own Frontend API (`/v1/client/handshake`, issuer origin) and back to this origin; anything else is refused;
- deletes the SDK's `format=nonce`, so the Frontend API returns a signed handshake token verified with the configured key. A nonce is refused: resolving one is a Backend API call an anonymous caller could repeat;
- applies the returned cookies only from the allowlist `__session`, `__client_uat`, `__clerk_db_jwt`, `__clerk_redirect_count` (plain or suffixed) with checked values (the session value must pass `inspectToken`), rewritten host-only: no `Domain`, `Path=/`, `SameSite=Lax`, `Secure` on https, `HttpOnly` except `__client_uat`. Any other cookie, or a handshake that does not resolve, refuses the request (400 or 502) and sets nothing;
- picks the staff instance on the operator route or when the browser holds a session token whose unverified issuer is the staff instance, and the client instance otherwise (it only chooses between the two configured instances; the SDK then verifies).

**Staff dev browser (development staff instance only).** A development portal on another origin signs in this browser's Clerk client only when handed its dev browser (`__clerk_db_jwt`), and both instances use that one cookie name here. The operator POST therefore forwards it only with a valid tie, `__clearcase_staff_dvb`: an HMAC-SHA-256 under the staff secret key over the app origin, the client id, the staff issuer and the value. A tie, or a checked `StaffDevBrowser`, from another app, client or staff instance does not count. A Clerk signature shows which instance signed a handshake, not which browser asked for it, so a tie is minted only on the return of a staff handshake this browser started here:

- the start sets the host-only, HttpOnly, SameSite=Lax cookie `__clearcase_staff_hs` and puts the same random 256-bit id in the handshake's `redirect_url` as `__clearcase_staff_hs`. The cookie carries the id, its issue time and whether the start could vouch for the dev browser it handed the Frontend API (none at all, or the one already tied here; a dev browser from the URL or an untied cookie may be planted), under an HMAC over the same scope;
- a return counts only with exactly one cookie and one id, equal, at most 600 seconds old, and a verifying MAC. Otherwise its cookies are applied as before but no tie is set, so a replayed, unsolicited, foreign-app, expired, malformed or repeated handshake leaves the operator POST forwarding nothing;
- any return clears the correlation cookie. That consumes it in this browser only. Nothing is stored server-side, so there is no global single use: the guarantee is that a replay needs the victim browser's own unexpired cookie together with an id that only that browser's own redirect carried. An attacker who can write cookies onto this origin is out of scope here, as for every Clerk cookie.

This adds no network call, Backend API lookup or D1 write, and production instances are unchanged. The client route still forwards any single plain `__clerk_db_jwt` to the client portal (a known open follow-up, not covered by the tie).

**One browser session per origin.** The client and staff instances share the cookie names on a client origin, so the flow does not run two credential channels: `planSignIn` signs the current session out first when the other kind signs in (`prepareSignIn` revokes it at its own instance and names its cookies to clear) and refuses an ambiguous credential (clearing it, 409). The session to sign out first may be a verified one or one whose signed token has expired while the Clerk session stayed live (revoke-only evidence, below); an expired session of the same kind is not revoked, Clerk replaces it. `presentedToken` never picks between two different credentials.

**Sign-out.** `/sign-out` calls `signOutClerkSession`. A verified session is revoked at the instance that issued it (`POST /v1/sessions/{id}/revoke` with that instance's secret key; a 404 is done). A session whose token has **expired** is revoked too, on revoke-only evidence (next section). Only then does it clear the Clerk session cookies the browser sent, plus the gate and `__session` cookies. If Clerk cannot confirm the revocation, or is not configured for a token-shaped credential, it answers 503 and clears nothing, so a live session is never reported ended. A caller with no credential, or whose credential is not a genuine token of a pinned instance (forged, wrong issuer, unsigned, ambiguous), revokes nothing and still gets its cookies cleared. A cookie set on a wider `Domain` by Clerk's own scripts cannot be cleared from here; a revoked session is refused by the status lookup regardless.

### Revoking a session whose token has expired (revoke-only, not authentication)

Clerk session tokens live about a minute, there is no clerk-js here, and sign-out is a POST that the handshake never refreshes, so a user idle for a minute reaches `/sign-out` or a cross-kind `/sign-in` anonymous (authentication is unchanged and still refuses the expired token) while the Clerk session behind the token is still live at the Frontend API. Without a revoke, the next Clerk sign-in on a shared device could resume it. `revocationEvidenceOf(token, config)` therefore gives a **separate** answer that is never an `Identity`, a `Principal` or a capability, and cannot reach a case, a grant or an audit actor:

- the token passes the shape gate (`inspectToken`), and its signature verifies with WebCrypto against the **configured public key** of the instance whose issuer its payload names (that unverified `iss` only chooses between the two configured keys; a token naming neither, or not signed by the chosen key, is refused, so key/issuer confusion between client and staff fails);
- the signed claims hold: the exact issuer, this origin as `azp`, the audience when configured, `sts` active when present, `sub` and a well-formed `sid`;
- `exp`, `nbf` and `iat` are deliberately **not read**: time never makes this token an identity, there is no clock tolerance, and nothing relaxes authentication;
- the revoke goes only to **that instance's** Backend API with that instance's secret key. `revokeOwnedSession` first reads `GET /v1/sessions/{sid}`: a session owned by anyone but `sub` is `invalid-session` and nothing is revoked; one already gone (404) or ended is done; a failed or unreadable lookup or revoke is `identity-unavailable`.

The unsigned `sid` of a cookie is never trusted: only a signature-verified token supplies one. Unrun: the real Clerk behaviour of these two Backend API calls, the browser cookie flow and the later real-browser handshake; this is offline unit evidence with synthetic keys and a loopback double, not a certification of any of them.

### What the parent must wire (nothing below is done)

1. Hook: before resolving identity, `const made = clerkBrowserHandshakeFromEnv(env); const r = made.ok ? handshakeResponse(await made.handshake.handle(request)) : null; if (r) return r;`, for document GETs of every route except `/sign-out`. Unconfigured, the hook stays out of the way (composition is `ready:false`).
2. CSP and Clerk hosts: form posts and redirects go to `CLERK_*_SIGN_IN_URL` and the instances' Frontend API hosts (`form-action`, navigation). No clerk-js is loaded; adding it would need `script-src`/`connect-src` and a JS-readable `__client_uat`.
3. Egress to `api.clerk.com` (or `CLERK_API_URL`) for session status and revocation.
4. `hosted/services.ts` composition, the import allowlist for `@clerk/backend`, `vitest.config.ts` including `tests/hosted-foundation/identity/**`, and `wrangler` vars and secrets (all as above).

## Not done here (UNVERIFIED or open)

- Nothing here has run against a real Clerk instance, Cloudflare, workerd or a browser. The handshake is unit-tested with a synthetic Frontend API host and keys. Whether Clerk's Frontend API returns a handshake token when `format` is absent, what cookies it returns (suffixed or not) and whether the cookie reaches the browser through the hook and CSP are all unproven.
- The first sign-in of an invited user, invitation acceptance, retry and interruption guidance, and reviewed logged-out support and information links (BA-19/20) are not implemented. The page says only "Accounts are by invitation only." (ADR-0008); that line and the 409 text need review.
- `Identity.authorize` stays the frozen callback for GRS-114; there is no default authorizer.
- Real Clerk proof: none. The GRS-108 probe (`docs/acceptance/hosting/identity.md`) is the closest evidence, for its own code.

## Dependency review

`@clerk/backend` 3.26.0 (MIT) resolves `@clerk/shared` 4.41.1 (MIT) and `standardwebhooks` (MIT); the GRS-108 probe used `@clerk/shared` 4.41.0. A diff of the two cached packages shows changes only in the React hooks, `loadClerkJsScript` and `versionSelector`, none in `error`, `isomorphicAtob` or `keys`, which is all this adapter uses. No advisory database was queried (no network), so the advisory status of the three packages is UNKNOWN, and nothing here is an audit.
