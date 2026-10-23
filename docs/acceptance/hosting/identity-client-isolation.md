# Two-client development identity proof (GRS-201)

Status: implemented, awaiting independent review and real Clerk acceptance (UNRUN). Base: `6a61e6500310431f851d79a6ed464028a59c9d57`. This extension reuses the GRS-108 identity app without changing it. It does not certify the hosted product, production sessions, sibling-subdomain cookies, CSP or Cloudflare deployment.

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

## Run and inspect

Use a dedicated Linux checkout with real Node 24 or newer and Bun 1.4.2. Install the existing identity workspace with `bun install --frozen-lockfile` in `tests/hosting-probe/identity`; no new dependencies are introduced. The probe builds that workspace, so do not run another identity build in the same checkout. Both clients and their staff frontends use distinct free loopback ports and four separate local stores. Four synthetic users, four invitations and ten sessions are expected: each client signs in at all four origins, plus one staff operator per world. Invitations use `notify: false`; all email-code sign-ins use `+clerk_test@example.com`.

From the repository root, wrap these commands with `scripts/agent-tools/receipt --base 6a61e6500310431f851d79a6ed464028a59c9d57 --name NAME --` (use the absolute real Node path if `node` resolves to Bun's shim):

```sh
node --test tests/hosting-probe/identity-client-isolation/check.test.mjs
node --test tests/hosting-probe/identity-client-isolation/cleanup.test.mjs tests/hosting-probe/identity-client-isolation/report.test.mjs tests/hosting-probe/identity-client-isolation/scenario.test.mjs
env PROBE_BUN=/absolute/path/to/bun node --test tests/hosting-probe/identity-client-isolation/runtime.test.mjs
bun tests/hosting-probe/identity-client-isolation/live.mjs
node tests/hosting-probe/identity-client-isolation/check.mjs .local/hosting-probe/identity-client-isolation/live-RUN/summary.json
```

The live launcher selects `CLIENT_A_PK`, `CLIENT_A_SK`, `CLIENT_C_PK`, `CLIENT_C_SK`, `STAFF_PK`, `STAFF_SK` from the existing private `clerk-dev` secrets file through `deploy/probes/secrets.ts`. C means the second client, not the existing B/staff app. Only the existing reader opens this file; the runner and Workers receive values through fd 3. Production keys and an unexpected issuer are refused before any identity is created.

The checker accepts only the exact clean source SHA; it includes the reused app, harness and secret-reader files in its input digest. It compares every request's command, assertion and observation to `transcript.mjs`. The runner verifies installed pins, the build host and stamp, native workerd processes, local environment settings, instance settings, session claims, non-audit store snapshots, cleanup counts and credential scan. The initial summary always says `evidence: false`; it becomes true only after these checks. Offline crafted controls cannot emit a live summary.

Issuer controls use the recipient gate's origin: client origin for client gates, staff origin for staff gates. Both the foreign client and the target's own client attempt every staff gate. The scanner runs after unsuccessful and interrupted attempts too. Cleanup attempts each identity independently and falls back to known created IDs when enumeration fails; any incomplete operation keeps the run failed.

A failed request stops the sweep but retains completed observations and the failed request's expected and observed fields in the scanned summary. Tokens, response bodies and exception text are excluded; partial results never pass the evidence checker.

Scan evidence includes a SHA-256 manifest of the actual files under the run directory and reused build. The checker re-enumerates and hashes them, requires logs, both clients' and staff stores, the build entry and immutable `summary-scan.json`, and refuses missing or altered coverage. Keep these ignored artifacts on the execution host; the summary alone is insufficient. Only final self-referencing reports and the known Bun transpiler-cache directories are excluded. This is a local evidence-integrity check, not a cryptographic attestation of an external provider run.

On a failed run, inspect the ignored run directory's `failure.json` and `run.json`. They contain the stage, cleanup counts and this run's exact random prefix, without credentials. SIGINT/SIGTERM/SIGHUP halt new creations and wait for the in-flight call before cleanup. SIGKILL cannot execute cleanup; its remaining identities require a run-prefix-scoped recovery on the execution host. There is no broad janitor or account-wide deletion.

Initial deterministic results at `adc1aefe`: 23 checker controls and the native-workerd reciprocal sweep passed through receipts. This is historical local evidence only; later revisions need fresh checks. Real Clerk and full local/hosted gates remain UNRUN. GRS-189 still owns strengthening the five existing probe summaries; this new checker does not replace that work.
