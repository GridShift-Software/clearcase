# Clerk sessions and explicit case authorization: the local and Clerk-development legs (GRS-108)

[GRS-108](https://linear.app/vaper/issue/GRS-108) asks for a working Clerk integration on Workers and an explicit role, session and asset authorization contract for the design gate. Cloudflare stays pinned (no account, token, login, DNS change or deploy), so this unit runs the **local and Clerk-development legs**: two SvelteKit 3 Workers on native workerd with local D1 and R2, verifying sessions of the real development instances `Clear-Case-Dev-A` (client) and `Clear-Case-Dev-B` (staff).

**Verdict: PASS for the local and Clerk-development legs; HOLD for the rest.** The committed run passed at `0b4872a4`, and `check:evidence` binds it to every later HEAD whose probe inputs are unchanged. Every acceptance item below that these legs can show passes. What stays HOLD, and who it needs, is listed [at the end](#what-stays-hold). The probe is not the production integration; GRS-113 adopts its contracts.

## Run it

From `tests/hosting-probe/identity/`, a workspace with its own pins and `bun.lock` in GRS-106's shape. It is not a member of the root workspace.

```sh
bun install --frozen-lockfile     # once, online
bun run --bun test                # offline: crafted issuers on workerd (gates.test.ts) and the evidence check (check.test.ts); the root run collects both too
bun run --bun probe               # online: the Clerk-development legs; writes .local/hosting-probe/identity/summary.json
bun run --bun check:evidence      # exit 0 only when the committed summary is evidence for HEAD's probe inputs
```

`probe` runs [`live.ts`](../../../tests/hosting-probe/identity/live.ts) on Bun, which starts [`probe.ts`](../../../tests/hosting-probe/identity/probe.ts) on a real Node under GRS-107's reader: `bun deploy/probes/secrets.ts run clerk-dev --keys CLIENT_A_PK,CLIENT_A_SK,STAFF_PK,STAFF_SK -- <node> probe.ts`. The reader hands keys to a real Node child only, and its preload takes them off fd 3 before the child's code runs, so the runner is Node; `live.ts` finds that Node past `bun run --bun`'s stand-in and names its own Bun for the build. The keys reach the runner through `takeSecrets()`, never through the environment, argv or a file. The runner hands them to [`serve.mjs`](../../../tests/hosting-probe/identity/serve.mjs) on another pipe, with the reader's own fd preload (`node --import=deploy/probes/secrets-fd.mjs serve.mjs`), so there is one protocol: the preload takes them off fd 3 before `serve.mjs` imports Wrangler, and `serve.mjs` passes them to workerd as `secret_text` bindings through Wrangler's `unstable_startWorker`. Every key, session token, dev browser JWT, invitation ticket and password the run sees is a canary: the summary, every log and the build output are scanned for each before the summary is written, and a hit fails the run without printing the value.

The runner refuses to start (exit 2) on a dirty tree, a runner that is Bun, a build Bun other than `packageManager`'s 1.4.2, an installed package that is not its pin, keys the reader did not hand over, or a missing key.

**The runner leaves nothing running.** `serve.mjs` runs in a process group of its own, so `harness.ts` ties it to its runner three ways: `serve.mjs` ends when its stdin, a pipe from the runner, ends (the runner exits, throws or is killed, `SIGKILL` included); the runner's `exit` event signals every live group; and on `SIGINT`, `SIGTERM` or `SIGHUP` (`live.ts` forwards all three through the reader) the runner halts the step that was running (from then on the Clerk client refuses any call that would create an object, and still deletes, reads and revokes), stops the groups, cleans Clerk (see [Clerk objects](#clerk-objects)) and exits 130, 143 or 129. `serve.mjs` itself exits 1 when Wrangler reports an error or one of its own workerd processes dies after "ready" (Wrangler raises no event for that), and a stop that has begun fixes its exit code, so an error while disposing the Workers cannot turn a clean stop into exit 1. The Workers listen on free ports, never fixed ones, so two worktrees can run at once. `gates.test.ts` starts a runner for each of six ways to end (exit, an error, `SIGINT`, `SIGTERM`, `SIGHUP`, `SIGKILL`) and requires `serve.mjs`'s process group, whose id the runner prints, to have no member within 20 s (`kill(-pid, 0)`; a free port would not show a workerd that outlives its host), and kills one workerd of a running world to show that `serve.mjs` and its group end.

## What runs where

| Step | Host |
| --- | --- |
| `vite build` with adapter-cloudflare 8.0.1 | Bun 1.4.2; the build prints its host and the runner asserts it |
| Launcher (`live.ts`) and GRS-107's reader | Bun 1.4.2 |
| Runner (`probe.ts`): Clerk Frontend and Backend API calls, app requests, assertions, summary | Node 26.10.0, the only child the reader hands keys to |
| `wrangler d1 execute --local`, `wrangler r2 object put --local`, `unstable_startWorker` (in `serve.mjs`) | Node 26.10.0 hosts Wrangler 4.151.3 only |
| The two apps | native workerd 1.20261019.1, descendants of `serve.mjs`, each with a local store of its own (`persistOf` in `harness.ts`); the runner asserts them from `/proc` |

Bun evidence covers the build and workerd evidence covers the app. The runner is test tooling, on Node because the reader requires it.

One build serves both apps: `APP_KIND` (`client` or `staff`, a deployment variable, never read from the request) picks the gate table, the trusted instances and the D1 database. The client app holds the case store (D1 `probe-identity-client`, R2 `probe-identity-client`); the staff app holds staff membership (D1 `probe-identity-staff`). All bindings are local.

## Contracts for the foundation owners

### Hook

[`src/hooks.server.js`](../../../tests/hosting-probe/identity/src/hooks.server.js) is the one place a request is admitted:

1. `gateOf(route.id, method)` looks the request up in [`src/lib/gates.json`](../../../tests/hosting-probe/identity/src/lib/gates.json). A route the app does not serve is 404 `not-served` and a method it does not take is 405, before any Clerk or D1 call. HEAD uses GET's gate.
   - **Default deny (no route, no gate).** A request whose `route.id` is null is never resolved ungated. A remote-function call (`event.isRemoteRequest`, `/_app/remote/...`) has no matching route in Kit 3.1.0 (`respond.js`), so a future `.remote.js` would otherwise run with no gate; it is refused 404 `not-served` before anything runs, signed in or not. Any other null-route request is refused 404 `not-served` without being resolved, so Kit's own 404 page is never served. A remote function is therefore a GRS-113 decision: it needs a gate table of its own, not a route in `gates.json`.
2. `public` resolves at once. Public routes never call Clerk or D1.
3. Otherwise `decide(event, gate)` runs. It verifies the session, reads the principal's role and grants from this app's D1, and writes an audit row; any exception is 503 `access-unavailable`.
4. A refusal is JSON `{error: 'denied', reason}` with `x-probe-denial: <reason>` and `cache-control: no-store`. A signed-out GET for a document (accept `text/html`) is a 303 to `/login?reason=<reason>&next=<path>` (BA-19). Clerk's handshake is a 307 with Clerk's headers. A handshake is not a decision: it has no principal and releases nothing, so it writes no audit row; the request that ends it runs the same gates and is audited like any other.
5. An allowed request runs with `event.locals.access = {principal: {app, subject, session}, role, caseId?, caseRole?, grant?}`, and its response is `cache-control: private, no-store`.

A route never checks access itself; it reads `locals.access` and scopes every read to the URL's case.

### Auth API

[`identity.js`](../../../tests/hosting-probe/identity/src/lib/server/identity.js), who is asking:

- `instances()`: the trusted instances, `own` (client app: the client instance, `CLERK_*` keys, authorized party `APP_ORIGIN`; staff app: the staff instance) and, on the client app, `staff` (`STAFF_*` keys, authorized party `STAFF_ORIGIN`) for the staff gates.
- `authenticate(event, instance)`, in order, the first failure denying, nothing cached across requests:
  1. at most one credential: a Bearer token, or the `__session` cookie, or both only when equal (401 `credential-malformed`, `credential-ambiguous`);
  2. `@clerk/backend` 3.26.0 `authenticateRequest` with `authorizedParties: [origin]` and `acceptsToken: 'session_token'`: signature against the instance's keys, `exp`, `nbf`, `iat`, `azp`. A signed-out state maps to `signed-out`, `token-expired`, `wrong-party` or `token-invalid`; a cookie request for a document whose token expired gets Clerk's handshake (interrupted-session recovery); an SDK exception is 503 `identity-unavailable`;
  3. the probe's own claim checks, so a missing claim fails closed: `iss` equals the instance's issuer (`wrong-issuer`), `sub` and `sid` are non-empty strings (`claim-missing`), `azp` is this app's origin (`wrong-party`, also when `azp` is absent, which Clerk's SDK allows), `sts` is `active` when present (`session-pending`), and `fva` shows a second factor when `AUTH_MFA_REQUIRED` is `"true"` (`mfa-required`);
  4. the session's current status from the instance's Backend API (`sessions.getSession(sid)`): owned by `sub` (`session-mismatch`) and `active` (`session-revoked`, `session-ended`). A lookup that fails is 503 `session-status-unavailable`, so a revoked session is refused on its next request while its token is unexpired.
- `verifiedEmail(instance, subject)`: the verified primary email, used only to match an invitation at enrolment, never to authorize.

[`access.js`](../../../tests/hosting-probe/identity/src/lib/server/access.js), what the principal may do, from D1 only:

- `gateOf(routeId, method)`, `decide(event, gate)` and `audit(principal, event, gate, caseId, outcome)`. Every decision on a protected route, allowed or denied, is an audit row written before the route runs; a failed audit write refuses the request.
- `recordInvitation(event, app, email, role)` (24 hours, single use) and `acceptInvitation(principal, email, app, roles)`, one D1 batch: the invitation for the caller's verified email is marked used and the membership row inserted together (201 with the role, 409 `already-a-member`, 403 `no-invitation`, 403 `email-unverified`).

Clerk holds identities and sessions only. Its users, sessions and invitations carry no role, grant or case: the probe asserts that every user's public, private and unsafe metadata and every invitation's metadata are empty, and that each session token carries only Clerk's v2 claims (`azp`, `exp`, `fva`, `iat`, `iss`, `nbf`, `sid`, `sts`, `sub`, `v`) and no case id.

### Role matrix

| Role (D1 `members.role`) | App | Enrolled by | May | Case content |
| --- | --- | --- | --- | --- |
| `global_admin` | staff | the provisioning SQL's first invitation (the initial admin) | list staff, invite operators (`global_admin` is provisioned by SQL only: the route invites `operator`), read the staff audit | none |
| `instance_admin` | client (the Global Admin's staff subject) | `/manage/accept` against a provisioning invitation | invite the firm's first firm admin, grant one case for 1 to 28,800 s to a live user of the staff instance (unknown, banned or locked: 404, audited), read the client audit | none without a grant |
| `operator` | staff | a Global Admin's invitation | with an unexpired grant: that one case's metadata, documents, drafts and Notes (nothing writes `revoked_at` yet: [revoke is a GRS-113 item](#contract-items-for-grs-113)) | only granted cases |
| `firm_admin` | client | an instance admin's invitation | list members, invite members, assign and unassign a member to a case (viewer or editor) | none until the firm admin assigns themselves to a case (an explicit, audited assignment, which `POST /admin/assignments` allows); no assignment, no case |
| `member` | client | a firm admin's invitation | list assigned cases; read an assigned case's metadata, document text, Notes and published assets; write Notes on an `editor` assignment | assigned cases only, never drafts |

Draft assets are served only on the operator routes. A member route serves only `published/` assets.

### Contract items for GRS-113

What this probe does not do, and GRS-113's design must:

- **Revoke an operator grant.** The grant table has `revoked_at` and `decide` honours it, but no route writes it, so a grant ends only by expiry (8 hours at most). GRS-113 adds `POST /manage/operator-grants/[id]/revoke` (instance-admin gate, audited with the case and the grantee) and tests that a revoked grant refuses the operator's next read.
- **Staff removal reaches the client app.** Staff enrolment lives in the staff app's D1, which a client app cannot read. At grant time the client app asks the staff Clerk instance (Backend API) whether the grantee is a live user, not banned or locked; that instance is invite-only, so an unknown subject is refused. A staff member removed from the staff app but still present in Clerk passes that check until their grants expire, and a staff role never reaches the client at all. GRS-113 must carry staff deactivation to every client app (revoking that subject's open grants) rather than rely on the Clerk lookup.
- **A remote function needs a gate table of its own.** The hook refuses every remote-function call; `gates.json` names routes, which a remote function is not.

### Route and gate table

All 34 (app, method, route) rows of `gates.json`; the probe sends each the classes listed and records the response. A refused class gets the reason shown and none of either case's markers; an allowed case-1 read carries case 1's markers and none of case 2's.

| App | Method | Route | Gate | Allowed | Refused beyond the five standard classes |
| --- | --- | --- | --- | --- | --- |
| client | GET | `/` | public | anonymous, expired, revoked | – |
| client | GET | `/login` | public | anonymous, expired, revoked | – |
| client | GET | `/support` | public | anonymous, expired, revoked | – |
| client | GET | `/information-handling` | public | anonymous, expired, revoked | – |
| client | GET | `/auth/session` | session | non-member 200, wrong-case 200, firm-admin 200, viewer 200, editor 200 | – |
| client | POST | `/invite/accept` | session | – | non-member 403 no-invitation, wrong-case 409 already-a-member, firm-admin 409 already-a-member, viewer 409 already-a-member, editor 409 already-a-member |
| client | GET | `/cases` | member | wrong-case 200, firm-admin 200, viewer 200, editor 200 | non-member 403 not-a-member |
| client | GET | `/cases/[case]` | case-read | viewer 200, editor 200 | non-member 403 not-a-member, wrong-case 404 no-case-access, firm-admin 404 no-case-access |
| client | POST | `/cases/[case]` | case-write | editor 200 | non-member 403 not-a-member, wrong-case 404 no-case-access, firm-admin 404 no-case-access, viewer 403 editor-required |
| client | GET | `/cases/[case]/documents/[doc]` | case-read | viewer 200, editor 200 | non-member 403 not-a-member, wrong-case 404 no-case-access, firm-admin 404 no-case-access |
| client | GET | `/cases/[case]/notes` | case-read | viewer 200, editor 200 | non-member 403 not-a-member, wrong-case 404 no-case-access, firm-admin 404 no-case-access |
| client | POST | `/cases/[case]/notes` | case-write | editor 201 | non-member 403 not-a-member, wrong-case 404 no-case-access, firm-admin 404 no-case-access, viewer 403 editor-required |
| client | GET | `/cases/[case]/assets/[...name]` | case-read | viewer 200, editor 200 | non-member 403 not-a-member, wrong-case 404 no-case-access, firm-admin 404 no-case-access |
| client | GET | `/admin/members` | firm-admin | firm-admin 200 | non-member 403 not-a-member, wrong-case 403 firm-admin-required, viewer 403 firm-admin-required, editor 403 firm-admin-required |
| client | POST | `/admin/invitations` | firm-admin | firm-admin 201 | non-member 403 not-a-member, wrong-case 403 firm-admin-required, viewer 403 firm-admin-required, editor 403 firm-admin-required |
| client | POST | `/admin/assignments` | firm-admin | firm-admin 201 | non-member 403 not-a-member, wrong-case 403 firm-admin-required, viewer 403 firm-admin-required, editor 403 firm-admin-required |
| client | DELETE | `/admin/assignments` | firm-admin | firm-admin 200 | non-member 403 not-a-member, wrong-case 403 firm-admin-required, viewer 403 firm-admin-required, editor 403 firm-admin-required |
| client | POST | `/manage/accept` | staff-session | – | global-admin 409 already-a-member, operator 403 no-invitation |
| client | POST | `/manage/firm-admin-invitations` | instance-admin | global-admin 201 | operator 403 instance-admin-required |
| client | POST | `/manage/operator-grants` | instance-admin | global-admin 201 | operator 403 instance-admin-required |
| client | GET | `/manage/audit` | instance-admin | global-admin 200 | operator 403 instance-admin-required |
| client | GET | `/operator/cases/[case]` | operator-grant | operator 200 | global-admin 403 no-operator-grant |
| client | GET | `/operator/cases/[case]/documents/[doc]` | operator-grant | operator 200 | global-admin 403 no-operator-grant |
| client | GET | `/operator/cases/[case]/drafts/[...name]` | operator-grant | operator 200 | global-admin 403 no-operator-grant |
| client | GET | `/operator/cases/[case]/notes` | operator-grant | operator 200 | global-admin 403 no-operator-grant |
| client | POST | `/auth/sign-out` | session | non-member 200 | – |
| staff | GET | `/` | public | anonymous, expired, revoked | – |
| staff | GET | `/login` | public | anonymous, expired, revoked | – |
| staff | GET | `/auth/session` | session | global-admin 200, operator 200 | – |
| staff | POST | `/invite/accept` | session | – | global-admin 409 already-a-member, operator 409 already-a-member |
| staff | GET | `/manage/staff` | global-admin | global-admin 200 | operator 403 global-admin-required |
| staff | POST | `/manage/staff-invitations` | global-admin | global-admin 201 | operator 403 global-admin-required |
| staff | GET | `/manage/audit` | global-admin | global-admin 200 | operator 403 global-admin-required |
| staff | POST | `/auth/sign-out` | session | operator 200 | – |

Refused on every protected row: anonymous (401 `signed-out`), expired (401 `token-expired`), revoked (401 `session-revoked`), wrong app (the other instance's valid token, 401 `token-invalid`) and wrong party (the right instance, minted for the other app's origin, 401 `wrong-party`). Public rows answer 200 to anonymous, expired and revoked alike and call neither Clerk nor D1.

### BA-19 and BA-20 entry points

- **BA-19, sign-in and session-establishment recovery: `/login`** on both apps, public. It reads only `reason` (one of the denial reasons above; anything else is `signed-out`) and `next` (a path on this origin, matching `^/(?![/\\])[A-Za-z0-9/_.-]*$`, else `/`). It renders `data-reason`, `data-next` and guidance for the reason, and never calls Clerk or D1. The hook sends a signed-out document request there with both set. On a development instance, a browser that has no `__clerk_db_jwt` yet is first sent through the Frontend API handshake to get one, and reaches `/login` on its way back. A token that has merely expired recovers without `/login`, through Clerk's handshake; a revoked or ended session lands there. GRS-113 mounts Clerk's sign-in component on this route.
- **BA-20, logged-out information and support: `/`, `/support` and `/information-handling`** on the client app (`/` on the staff app), public, static, no Clerk or D1 call. Their copy is a placeholder, marked `data-copy="placeholder-for-review"`; it is not legal or information-handling text and needs review before any hosted use.

## What `__clerk_db_jwt` means on each leg

A development instance's Frontend API is on a Clerk domain, a third party to the app, so Clerk cannot keep the browser's Clerk client in first-party cookies. Instead a development browser is a JWT, `__clerk_db_jwt`, minted by `POST /v1/dev_browser`; clerk-js sends it on every Frontend API call and keeps a copy on the app's origin. It names the Clerk client (the browser's sessions). It is not a session token, and the app never treats it as a credential: the hook verifies only `__session` or a Bearer token.

| Leg | `__clerk_db_jwt` |
| --- | --- |
| offline (`gates.test.ts`) | absent: crafted tokens, no Frontend API |
| invite-only, revocation, expiry, route matrix | the runner opens one development browser per synthetic person and sends its JWT on every Frontend API call, with a Backend API testing token to pass bot protection. That lets one process hold several independent Clerk clients |
| wrong party | a development browser opened with the other app's Origin: the instance stamps `azp` from the Origin, so the token is the right instance's and the wrong app's |
| interrupted-session recovery | the app sees an expired `__session`, `__client_uat` and `__clerk_db_jwt` on a document request; Clerk's SDK redirects to the Frontend API handshake with the dev browser JWT, which identifies the client, and the app takes the handshake's fresh `__session` on the way back |
| public entry (BA-19) | a logged-out document request from a browser with no `__clerk_db_jwt` is a 307 to the Frontend API handshake, which gives it one; with its dev browser and `__client_uat=0` the same request is the 303 to `/login?reason=signed-out&next=/cases/case-1`. Production has no such first hop |
| production (HOLD, M3) | absent: production instances keep the client in first-party cookies on the custom domain's Frontend API subdomain, so sibling-subdomain cookie scoping is a production question |

The dev browser JWT is a bearer handle for the browser's Clerk client in development; the runner treats it as a canary and never records it.

## Acceptance items

Legs: **offline** is `bun run --bun test` (crafted issuers on workerd, no Clerk); **Clerk dev** is `bun run --bun probe` against `Clear-Case-Dev-A` and `Clear-Case-Dev-B`; **hosted** is a deployed Worker on a custom domain, which waits for Cloudflare and moment M3.

| Acceptance item | Offline | Clerk dev | Hosted |
| --- | --- | --- | --- |
| Separate client and staff Clerk applications; a real SvelteKit and Workers integration through `@clerk/backend` (no Svelte wrapper assumed) | PASS | PASS (integration, instances) | HOLD (M3) |
| A second client application (wrong client issuer and audience) | – | HOLD (needs client B) | HOLD |
| Invite-only staff, initial admin and client user flows | PASS (crafted invitations: one use, email bound, expiry) | PASS (invite-only, instances) | HOLD |
| Server-side token verification | PASS (16 crafted claim, key and algorithm cases, credential ambiguity) | PASS (route matrix: wrong app, wrong party) | HOLD |
| Expiry, revocation and interrupted-session recovery | PASS (session status revoked, ended, mismatched; status outage 503) | PASS (expiry-and-recovery, revocation, restart) | HOLD |
| Case grants, documents, text and Notes outside Clerk | PASS | PASS (grants-outside-clerk) | HOLD |
| Firm admins and the Global Admin get no automatic case content; operator access explicit and audited | PASS (self-assignment explicit and audited by case; a grant needs a live staff user; failed audit write is 503) | PASS (operator-access, route matrix) | HOLD |
| Wrong-case, logged-out and revoked sessions refused on every route: metadata, user work, draft and published assets, mutations | PASS | PASS (route matrix, 251 checks) | HOLD |
| Sibling-subdomain isolation | – | HOLD (M3) | HOLD (M3) |
| MFA off, with a server-side flag and no usage threshold | PASS (flag off and on) | PASS (instances: no second factor) | HOLD |
| Hooks, auth API, role matrix, BA-19 and BA-20 entry-point contracts | defined above; default deny proved (remote-function request: 404 `not-served`) | PASS (public-entry) | HOLD (CSP at M3; BA-20 copy needs review) |

## Legs

| Leg | What it asserts at `0b4872a4` |
| --- | --- |
| integration | the Bun build with adapter-cloudflare is stamped with HEAD; `authenticateRequest` is in the server bundle with no `node:crypto` import; Wrangler seeds both apps' local D1 and R2 in its own process; `serve.mjs` starts both Workers with the keys as `secret_text`; native workerd serves them and both serve the HEAD stamp |
| instances | each Frontend API is the named development instance; sign-up is restricted; MFA is not required and no second factor is enabled; Clerk refuses a sign-up with no invitation (403 `sign_up_mode_restricted`) |
| invite-only | the first Global Admin signs up through a Backend API invitation (ticket) and enrols from the deployer's D1 invitation; the Global Admin enrols on the client app (`/manage/accept`), invites an operator and the firm admin; the firm admin invites and assigns viewer1, editor1 (case 1) and viewer2 (case 2); outsiders created directly in Clerk, signed in by email code, are refused on both apps |
| grants-outside-clerk | every user's public, private and unsafe metadata and every invitation's metadata is empty; tokens carry only Clerk's v2 claims and no case id; D1 holds 3 assignments, 5 client members and 2 staff members |
| operator-access | the Global Admin and the operator read no case before a grant; a 10-minute grant opens case 1's metadata and draft and nothing of case 2; a 20-second grant on case 2 lapses; every read and refusal, and the grant itself with its case, is an audit row with no case content; a grant to a subject that is no user of the staff instance is refused (404) and audited; a firm admin cannot read the audit |
| revocation | after app sign-out, and after a Backend API revoke, the same unexpired token is refused on its next read and its mutation (401 `session-revoked`); Clerk refuses a new token for the session; removing an assignment closes the case to an active session (404) |
| expiry-and-recovery | development tokens live 60 s; past `exp` and the 5 s skew a read and a Note are refused and nothing is written; the browser refreshes the same session through the Frontend API; the retried Note is saved once (201, then 200 replayed); an expired `__session` cookie on a document request goes through the handshake and comes back to case 1 with a fresh cookie and no new sign-in; a revoked session lands on `/login` with its reason |
| restart | `serve.mjs` and workerd stop on SIGINT; after the restart the same Clerk session mints a token with no new sign-in and the Note is still there |
| route-matrix | 34 routes, 251 checks (196 refused, 55 allowed), each matching `matrix.ts`; no refusal carries a marker of either case and every allowed case-1 read carries its own; each class changed D1 by exactly its allowed writes |
| public-entry | the BA-19 and BA-20 pages answer 200 logged out, with a stale cookie, set no cookie and carry no case content; a logged-out document request without a dev browser goes to the handshake first; with one it is a 303 to `/login?reason=signed-out&next=%2Fcases%2Fcase-1`; `/login` refuses an off-site return path; BA-20 copy is marked `placeholder-for-review` |
| cleanup | every session the run created is gone or ended (read from Clerk, none pending); no user or invitation of the run is left in either instance, and both instances' user and pending-invitation counts are back at the run's baseline |
| credential-scan | no key, token, dev browser JWT, ticket, password or credential shape in the 326 files of logs, local state, the build and the summary |

## Clerk objects

Every object is synthetic: `+clerk_test` addresses on `example.com` (a reserved example domain), the test verification code, and random passwords. Cleanup runs once, in `finally` or on `SIGINT`, `SIGTERM` or `SIGHUP`, whichever comes first, even after a failure. It stops `serve.mjs`, then tries every object: invitations first (deleting a user also deletes their accepted invitation, so the ledger records those as deleted), then users, across both instances, noting each failure and still trying the rest, and reports them all together. Then it reads each session's own status from Clerk (a 404, or any status but `active`; a `pending` session is counted apart and fails the run), and checks each instance's user and pending-invitation counts against the run's baseline. Before anything else a start-of-run sweep deletes `cc108-*` invitations and then users older than an hour (a row for which Clerk states no finite creation time is never swept as old; the sweep counts such rows, prints its four counts, zeros included, and records them in the summary's `sweep`: users and invitations removed, undated rows left in place, and failures, so a stranded row shows; the run's own cleanup still deletes it by its prefix), which a run killed before its cleanup leaves behind; it prints what it removed (nothing, at the committed run, and no undated row). A create that is queued behind Clerk's rate limit when the run is interrupted is refused when its turn comes: `Backend.call` checks the halt again after the wait.

| Object | Created | Deleted or ended |
| --- | --- | --- |
| Users (both instances) | 8 | 8 |
| Invitations | 9 | 9 |
| Sessions | 14 | 14 ended (read from Clerk), 0 pending |
| Testing tokens, development browsers | 17, 17 | expire on their own |
| Backend API calls | 88 | – |

MFA stayed off: no user enrolled a second factor and the instances enable none.

An earlier run was interrupted on purpose: `SIGINT` to `live.ts` during `operator-access`, with the Workers up and 8 users, 6 invitations and 8 sessions created. The handler stopped `serve.mjs` and its workerd and deleted or ended all of them (users 8/8, invitations 6/6, sessions 8/8, cleanup PASS), and the next run's sweep found nothing to remove.

## Evidence and its binding

The committed run is [evidence/identity-summary.json](evidence/identity-summary.json). It binds to:

- `sourceSha`, the commit the run built and served (the served Kit version stamp equals it); the check refuses a summary whose `sourceSha` is not HEAD or an ancestor of it, and never substitutes HEAD for it;
- `inputs.digest`, sha256 of `git ls-tree -r --full-tree <rev> -- tests/hosting-probe/identity deploy/probes/secrets.ts deploy/probes/secrets-child.mjs deploy/probes/secrets-env.mjs deploy/probes/secrets-fd.mjs deploy/probes/scan.ts` (the git object ids of exactly the inputs, the rule GRS-107's deployment check uses; `scan.ts` is there because `probe.ts` imports it), which must be equal at `sourceSha` and at HEAD. A commit elsewhere in the repository, or a merge that leaves these paths alone, keeps the summary valid; any change to them makes it stale.

`check:evidence` also compares the whole summary with one exact shape, recomputes every expectation of the route table from `matrix.ts` at HEAD, recomputes the counts, requires every Clerk user, invitation and session created to be deleted or ended (`sessions.ended` is counted from each session's status in Clerk, and `sessions.pending` must be 0), and requires the sweep's four counts, each a whole number of zero or more. `check.test.ts` mutates a passing summary in more than 5,000 ways (every field deleted, nulled, retyped, emptied, flipped or zeroed, and an unknown key in each object) and the check refuses all of them; it also proves the binding in a scratch repository.

`deploy/probes/scan.ts` is bound. The credential-scan leg imports it, and the leg's claim, no hit in 326 files, is that scanner's answer at the run's revision: a scanner changed later must be shown to give the same answer, which is a new run, not an old summary. `check.test.ts` asserts a change to it makes the summary stale, and a change to the rest of `deploy/probes/` does not.

On 21 October `wave/proofs` moved to `b858213c` when GRS-107 merged (PR #97) with a changed reader. In a scratch checkout of the earlier run's commit merged with it, the same check refused that run's summary: `summary.inputs.digest` was stale, because `deploy/probes/secrets.ts` and `secrets-child.mjs` had changed. This branch then merged `wave/proofs` (`19f82058`), moved the runner to Node for the new reader (`ad1d0eb0`), and ran again. In a scratch checkout of `ad1d0eb0` merged with `origin/wave/proofs` (already an ancestor, so Git reports "Already up to date"), `bun tests/hosting-probe/identity/check.ts` prints `CHECK PASS` and exits 0. `check.test.ts` covers a merge that does bring changes outside the inputs.

## Checks

The probe's own checks, all in `tests/hosting-probe/identity/`:

| Command | Revision | Exit | Result |
| --- | --- | --- | --- |
| `bun run --bun test` | `0b4872a4` | 0 | 61 passed: `gates.test.ts` 45 (33 gate cases, 2 default-deny, the grant-to-a-non-staff-user case, 6 process-lifecycle, 3 on `serve.mjs`'s stores, start and a dead Worker), `check.test.ts` 12, `clerk.test.ts` 4 |
| `bun run --bun test tests/hosting-probe/identity/ tests/ci/test-collection.test.ts`, from the repository root | `0b4872a4` | 0 | 63 passed under the root config (the identity files are collected there now) |
| `bun run --bun probe` | `0b4872a4` | 0 | `PROBE PASS`, `evidence: true`, all 12 legs PASS, 0 scan hits; sweep removed nothing; users 8/8, invitations 9/9, sessions 14/14 |
| `bun run --bun check:evidence` | `0b4872a4` and the commit that adds this page | 0 | `CHECK PASS`, inputs `sha256:9496df89…` |
| `bun tests/hosting-probe/identity/check.ts` after `git merge origin/wave/proofs` (`b858213c`, already an ancestor) in a scratch checkout | the commit that adds this page | 0 | `CHECK PASS` |

Receipts are under the worktree's ignored `.local/agent-receipts/`. The repository's `check`, `gate:hosted` and `gate` results are in the ticket's report at the hand-in head.

## What stays HOLD

| Item | Why | Who, and what |
| --- | --- | --- |
| Wrong-client issuer and audience | Only one client development application exists, so no token of another client instance can be presented to client A | The user: create a second Clerk development application, `Clear-Case-Dev-C` or similar (restricted sign-up, email code, MFA off, no social connections), and add its keys to `clerk-dev` as `CLIENT_B_PK` and `CLIENT_B_SK`. The probe then adds a third Worker for client B and the class "client B's valid token on client A" |
| Sibling-subdomain session isolation | Development instances keep the Clerk client in `__clerk_db_jwt`, not in first-party cookies on the app's domain | The release reviewer at moment M3, on production instances with custom domains under `sandbox.gridshift.co.za` |
| Hosted CSP for clerk-js and the Frontend API | The probe serves no clerk-js and sets no CSP | The release reviewer at moment M3 |
| Clerk production instances | Custom domains, Frontend API CNAMEs and production keys | The release reviewer's provisioning step at moment M3 |

The Cloudflare legs (deployed Workers, remote D1 and R2) wait for the user to unpin Cloudflare.
