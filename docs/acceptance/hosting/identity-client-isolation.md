# Two-client development identity proof (GRS-201)

Status: implementation pending; real Clerk acceptance UNRUN. Base: `6a61e6500310431f851d79a6ed464028a59c9d57`. This extension reuses the GRS-108 identity app without changing it. It does not certify the hosted product, production sessions, sibling-subdomain cookies, CSP or Cloudflare deployment.

## Test plan (committed before implementation)

| Actor | Action | Required observation; failure condition |
| --- | --- | --- |
| Runner | Start two local client worlds using separate D1/R2 directories and actual Clerk A and C development issuers | Both serve the exact build SHA; shared stores, wrong app identity, production keys or stale/dirty inputs refuse the run |
| Client editor in each world | Read case metadata, extracted text, Notes and published assets, then create a Note | Exact positive status and expected synthetic marker; absent content or failed write fails |
| Client of the other issuer | Send a fresh token to each protected client route, in both directions | 401 with no content markers, including private draft and mutation surfaces; any acceptance or content leak fails |
| Same issuer at the other origin | Present a genuine session with the wrong authorized party | 401 wrong-party on each protected client route; denial for expiry or another reason does not prove this leg |
| Authorized staff operator | Read private draft in each client world | Own draft marker present; client tokens must still be denied on staff-only routes |
| Mutation observer | Compare local authorization and user-work tables before and after hostile requests | No change except refusal audit rows; a denied request with side effects fails |
| Runner | Finish normally or receive an interruption | Only this run's prefixed synthetic users/invitations removed; every created session ended or gone; cleanup failure prevents PASS |
| Credential scanner | Scan output, logs and build with exact in-memory secrets/tokens as canaries | No hit; failed/incomplete scan prevents PASS and no credential value appears in diagnostics |
| Evidence checker | Read the recorded summary at its exact source revision | Exact reviewed transcript, environment, route/control coverage, positive results, digests and cleanup required |
| Adversarial offline controls | Invent a command/assertion, remove a direction/positive, alter an environment value, claim a stale digest or incomplete cleanup | Each independently refuses; a genuine synthetic checker fixture passes only as a unit-test fixture |
| Offline runtime control | Exercise the real probe app on workerd with crafted issuers and a loopback Clerk status double | Confirms runner/request assertions locally; explicitly not real Clerk acceptance |

The app exposes extracted-text and synthetic published/draft asset routes, not an original-file route. Original downloads remain outside this proof. Its verifier checks signature, issuer and authorized party (`azp`); it does not configure an `aud` requirement. No audience validation claim is made.

## Scope and execution boundary

Writes are confined to this document and `tests/hosting-probe/identity-client-isolation/`. Existing identity code, secret reader and GRS-189's checker work are read-only. Account resources, DNS, subscriptions, production Clerk, email and real case material remain outside scope. Local D1/R2 and native workerd are real; only the live mode uses real Clerk development sessions.

Credentials must enter through the existing private secrets reader. Never put values in arguments, logs, Git, Linear or chat. The new client app is Clear-Case-Dev-C (`outgoing-walrus-1020.clerk.accounts.dev`); A remains the first client and B the staff app. Public account identifiers are configuration, not proof of a successful run.

Native doctor on this Windows host cannot start because `/bin/bash` is absent. The available Linux Docker host lacks external tooling admission and private v5 fixtures. Record these limitations separately from each command's result.

References: [Clerk request verification](https://clerk.com/docs/reference/backend/authenticate-request), [Clerk synthetic email addresses](https://clerk.com/docs/guides/development/testing/test-emails-and-phones), [Wrangler local runtime API](https://developers.cloudflare.com/workers/testing/unstable_startworker/).
