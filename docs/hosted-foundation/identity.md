# Hosted identity: the Clerk IdentityProvider (GRS-113)

Status: PREPARED, UNVERIFIED. Unit tests use synthetic keys and a loopback session lookup. They are evidence for this adapter only. No real Clerk instance, Cloudflare resource or browser has exercised it.

The hosted client deployment authenticates with Clerk ([ADR-0007](../adr/0007-hosted-client-isolation-and-identity.md), [ADR-0008](../adr/0008-workers-runtime-and-cloudflare-first-stack.md)). Each deployment trusts two separate Clerk applications: its own client instance, for the firm's users, and the internal staff instance, for operators and the Global Admin. Clerk holds identities and sessions only. A case decision belongs to the case-grant and audit owner (GRS-114), whose data lives outside Clerk.

## Modules

| Module | What it is | Imports the SDK |
| --- | --- | --- |
| `src/lib/auth/clerk/config.ts` | `readClerkIdentityConfig(env)` and `clerkSignInTarget(env, returnTo)`: pure, no network, no secret in any result | no |
| `src/lib/auth/clerk/provider.ts` | `clerkIdentityProviderFromEnv(env, { authorizeCase })` and `createClerkIdentityProvider`: the `IdentityProvider` of `runtime/contracts.ts`, plus `signOut` | `@clerk/backend` 3.26.0 (exact pin) |
| `src/lib/auth/clerk/session.ts` | the `__session` cookie name, for routes | no |

## Configuration

Every value comes from the Worker env, never from a request. Any missing or malformed value makes the whole configuration unavailable. The reason names variables, never values.

| Variable | Kind | Rule |
| --- | --- | --- |
| `CLEARCASE_CLIENT_ID` | var | the one client this deployment serves (same variable as `bindings.ts`) |
| `CLEARCASE_APP_ORIGIN` | var | this deployment's origin; the only authorized party (`azp`) a token may name; https, or http on loopback |
| `CLERK_CLIENT_PUBLISHABLE_KEY`, `CLERK_CLIENT_SECRET_KEY` | var, secret | the client instance; its issuer is `https://` plus the host the publishable key names |
| `CLERK_CLIENT_JWT_KEY` | secret, optional | PEM public key for networkless verification; without it the SDK fetches the JWKS with the secret key |
| `CLERK_STAFF_PUBLISHABLE_KEY`, `CLERK_STAFF_SECRET_KEY`, `CLERK_STAFF_JWT_KEY` | as above | the staff instance; it must be a different application (issuer, publishable key and secret key all differ) |
| `CLERK_API_URL` | var, optional | Backend API base; https, or http on loopback (tests) |
| `CLERK_CLIENT_SIGN_IN_URL` | var, optional | the client instance's sign-in page that `/sign-in` links to; without it `/sign-in` stays 503 |
| `AUTH_MFA_REQUIRED` | var, optional | `"true"` requires a second factor (`fva`); absent or `"false"` is off (ADR-0008: initially off) |

## What one request goes through

1. One credential: a Bearer token or the `__session` cookie, or both only when they are equal. None is `unauthenticated`. A malformed or ambiguous credential is `invalid-session`.
2. `verifyToken` from `@clerk/backend` against the client instance, then the staff instance. It checks the signature with that instance's key, `exp`, `nbf`, `iat`, the instance's exact issuer, and this origin as the only authorized party.
3. Our own claim checks, because the SDK tolerates some missing claims: `sub` and `sid` present, `azp` present and equal to the origin, `sts` (when present) `active`, and a second factor when the MFA flag is on.
4. The session's current status from the issuing instance's Backend API: `active` and owned by `sub`. `checkRevocation()` and every `authorize()` repeat this lookup, so a revoked session is refused while its token is unexpired.

A refused credential yields an anonymous identity whose checks throw the refusal (401 through `refuse`). A Clerk fault throws `identity-unavailable` (retryable) from `authenticate` itself: unavailable keys or JWKS, or a failed status lookup other than 404. No Clerk metadata, role or claim grants anything.

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
- `wrangler.toml` and the secrets need the variables above. The Worker reaches the Clerk Backend API (`api.clerk.com`) for session status, and for the JWKS when no JWT key is set.
- Sign-out at Clerk: `/sign-out` clears `clearcase_session` and `__session`, but only the composer holds the provider. Revoking the Clerk session needs `provider.signOut({ principal, sessionId })` called from the composition, or a request service that exposes it.

## Not done here (UNVERIFIED or open)

- Getting a Clerk session cookie onto this origin after sign-in at Clerk's page is not implemented. On a development instance that is Clerk's handshake (`authenticateRequest`, `__clerk_db_jwt`) or clerk-js on the page. Either needs a hook-level decision and CSP. Bearer tokens work through the provider today.
- A staff browser session on a client origin shares the `__session` cookie name with client sessions. That needs a design (for example Clerk's suffixed cookies) before staff sign in through the browser.
- Real Clerk proof: none. The GRS-108 probe (`docs/acceptance/hosting/identity.md`) is the closest evidence, for its own code.
