# Native alpha custom-domain controls

Status: **PREPARED / UNVERIFIED**. The local plan and its unit tests exist. No remote control has run, so nothing here is REMOTE CONTROL-READY, provider proof or a funding decision.

## Why this is new

The GRS-203 stop sends only `POST /accounts/<account>/workers/scripts/<worker>/subdomain` with `{enabled:false, previews_enabled:false}`, and it refuses any non-empty `publicRoutes`. Within that closed-ingress contract it is complete, and this document makes no claim that it fails its own spec. The native alpha, however, serves clients on Workers custom domains (`a.sandbox.gridshift.co.za` and `b.sandbox.gridshift.co.za`), which the GRS-203 stop cannot unbind. `deploy/native-alpha/controls.ts` adds that capability as a separate module. It does not edit GRS-203, `deploy/probes/**`, `cloud-run.ts` or the janitor.

## Evidence states

| State | Meaning | Who reaches it |
| --- | --- | --- |
| LOCAL-PLAN-VERIFIED | The private unit tests pass at an exact SHA, with injected data only | This module |
| `UNIT-CONTRACT-ONLY` | Canary data satisfies the contract shape, but at least one observation is injected | `checkNegativeProof` |
| `NETWORK-LABELLED-STRUCTURALLY-CONSISTENT` | **Structural only.** Every observation is labelled `network` and carries a well-formed `provenance`, and the contract shape holds. The label and the provenance are self-asserted data: this validator runs over injected data, so it cannot certify remote proof, and the name must not be read as proof. The result carries `remoteProof:false` and `structuralOnly:true` | `checkNegativeProof` |
| REMOTE CONTROL-READY | The parent has a funded manifest, a scoped apply, a fresh provider readback and authenticated real negative canaries at an exact SHA | Parent only, not run |
| FUNDED | An all-in allocation within USD 10, with retention accepted by the user | User/parent only, not decided |

`StopResult.providerProof` and `controlReady` are always `false`. `retainedStorageBills` is always `true`: D1, R2 and Worker versions are retained, and they keep billing after ingress stops. No hard cap on money is claimed.

## Manifest (`clearcase.native-alpha-controls/1`)

Every client must belong to `APPROVED_NATIVE_SCOPE`: account `fb4c31b91c5d89b7a54afbdc34823170` and zone `clearcase.co.za` / `1c82369e826ebe0afded65c295198fcd` (hostnames `sbx-a.clearcase.co.za` and `sbx-b.clearcase.co.za`; the bind and rollback plan is `deploy/native-alpha/custom-domain-bind.ts`), with that client's approved Worker, hostname, D1 name and R2 bucket. The current plan has two clients, but that comes from the scope list. The code has no fixed client count. Each client entry has exactly these keys:

- `client`, `worker`
- `domain {id (32 hex), hostname, zoneId, service = worker, environment = production}`
- `versionIds`: the retained Worker version UUIDs
- `secretNames`
- `d1 {binding: DB, name, id (UUID), jurisdiction: eu}`
- `r2 {binding: BUCKET, bucket, jurisdiction: eu}`
- `release {sourceSha, artifactSha256, profileRevision}`
- `canary {appPath, assetPath, assetSha256}`

The parser refuses:

- unknown keys, including `publicAccess` and `directBypass`
- wildcard or foreign hostnames, another client's hostname, and a foreign account, zone or service
- non-EU storage
- duplicated clients, domains, D1 IDs or versions

It returns a deep-frozen copy.

## Operations and sources

The paths come from the official `cloudflare-typescript` SDK 5.2.0 resources, which are generated from Cloudflare's API spec and vendored in `node_modules/wrangler/wrangler-dist/cli.js` (Wrangler 4.151.1). No account request or credentialed call was made.

- **Stop**, per client and once each:
  - `POST /accounts/{a}/workers/scripts/{worker}/subdomain {enabled:false, previews_enabled:false}` (`workers.scripts.subdomain.create`)
  - `DELETE /accounts/{a}/workers/domains/{domainId}` (`workers.domains.delete`, "Detaches a Worker from a zone and hostname")
  - `stopOperationProblems` refuses every other operation, including deletes of Workers, D1, R2, secrets, routes and DNS records, the workers.dev DELETE, and re-enabling bodies.
- **Re-attach plan** (not run): `PUT /accounts/{a}/workers/domains {environment, hostname, service, zone_id}` (`workers.domains.update`).
- **Fresh readback**, GET only:
  - the account's unfiltered `workers/domains`
  - the approved zone's `workers/routes` (single page in the SDK)
  - the account's complete zone list, `GET /zones?account.id=<account>` with page pagination (`zones.list`, `V4PagePaginationArray`: read pages until `page * per_page >= total_count`; the `account.id` filter is the one wrangler 4.151.1 itself sends, because the vendored SDK JS has no parameter types), then `GET /zones/{zone}/workers/routes` for every other listed zone (`zoneRoutesReadOperation`)
  - per Worker: `subdomain`, `versions`, `deployments` and `secrets`
  - `d1/database/{id}`
  - `r2/buckets/{bucket}`, plus its `domains/managed` and `domains/custom`, each with `cf-r2-jurisdiction: eu`

### Unverified side effects

Detaching a domain may also remove its DNS record or certificate. This is why the stop now refuses to dispatch it without a reviewed KNOWN policy (see the domain detach gate). The SDK text does not state these effects, so they are an open gap. Real re-attach timing is also unverified. Wrangler internally reads `workers/domains/records` and posts `scripts/{name}/domains/changeset`, and its records carry `enabled` and `previews_enabled`. That could allow a non-delete domain disable, but these endpoints are absent from the SDK, so they are not used. Workers routes have no reviewed non-destructive disable. Any route that runs on an owned Worker or covers an owned hostname therefore causes a HOLD; routes are never deleted. Hostnames and patterns are matched ignoring case, a trailing dot and the `http(s)://` scheme. `*` matches any run of characters, so `a.sandbox.gridshift.co.za*` and `*/*` cover the host. A wildcard custom-domain hostname, a pattern with any other syntax (another scheme, a port, a query, a backslash, a leading space or a non-string) and a route to an owned Worker named in another case all fail closed.

### Complete route inventory (M3)

A route in another zone of the same account that runs an owned Worker would keep serving after the stop. A readback therefore carries `routesComplete`, `accountZones {complete, items}` and `otherZoneRoutes [{zoneId, complete, routes}]`. The approved zone must be in the inventory, and every other listed zone needs exactly one complete route list. An incomplete, missing or truncated inventory, an unlisted zone or an unreadable pattern is a HOLD. These are boolean claims by whoever assembled the readback. They are not proof of the provider's response, and the actual read adapter (with its pagination loop) is still owed by the parent. No account-wide routes endpoint is used, and nothing is mutated in a foreign zone.

## Stop orchestration (`stopNativeAlpha`)

The caller injects `now`, `stopOwnerRequests`, `readState` and `dispatch`. There are no defaults, environment reads, timers or imports.

1. The manifest is copied and frozen before the first await.
2. New owner requests are stopped first.
3. The before-state must be complete, fresh (no more than 60 s old) and exact, with each reviewed domain bound once and no other domain or route exposure.
4. Each planned operation is dispatched once, with no retry and no fallback.
5. The after-state is read fresh, and it must be observed **strictly after the completion of the LAST dispatched action**, not after the start of dispatch. It must show no owned domain bound, workers.dev and previews both false, identical retained versions, secret names, EU D1 and private EU R2, and the complete route inventory below.
6. A missing callback, failed dispatch, partial disable, stale or unknown state, unreadable after-state, throwing clock or non-monotonic clock ends in a HOLD. The result records what was dispatched, and the uncertain liability is retained. Comparisons ignore the provider's key order.

### Clock and records (H1)

Every clock reading must be finite and not earlier than the one before it. Each dispatched record is `{op, outcome, startedAt, completedAt}`, with the completion read after that action's await. The result also records `dispatchedAt` (the first start), `completedAt` (the last completion), `beforeCheckedAt` and `afterCheckedAt`. A clock fault during dispatch does not stop the frozen plan (each action is still sent once, never retried), but the stop is then untimed and ends in a HOLD. The manifest, the policy and the plan are fixed before the first await.

### Domain detach gate (M4)

The domain DELETE is dispatched only when the caller supplies a `domainDetachPolicy` whose `status` is `KNOWN`. A missing or `UNKNOWN` policy (`UNKNOWN_DOMAIN_DETACH_POLICY` is the default) is a HOLD **before any dispatch**: nothing is sent to the provider, including the workers.dev disable. A KNOWN policy must have the schema `clearcase.native-domain-detach-policy/1`; apply to exactly this account, zone and these domains; state `dnsRecord` and `certificate` as `retained` or `removed`; have `newPaidCertificate:false` and `otherDnsRecordsTouched:false`; and name a primary source (https document, section, excerpt digest). `domainDetachPolicyProblems` checks this shape only. It is **not** owner approval or provider proof, and the code never creates a KNOWN policy. Today no reviewed KNOWN policy exists, because the SDK does not state the DNS or certificate effect. The parent needs primary Cloudflare documentation before any apply.

## Negative-proof contract (`checkNegativeProof`)

The contract needs, for each client's custom domain, both an app canary and an original-asset canary. Each observation has `requestedAt` and `respondedAt` (never earlier than the request):

- **Before**: an authenticated request as that client, resolved through public DNS with a matching TLS hostname, returns 200 and a cache miss. It is no older than `READBACK_MAX_AGE_MS` before the before-readback, starts before the first action and finishes by then. The app canary must serve the deployed `sourceSha`, and the asset canary the deployed `assetSha256`. A canary is not required to follow the before-readback; the before-readback is what verifies the binding immediately before the dispatch.
- **After**: a request taken after the after-readback ends in a classified network error, or in an error response that carries no build, no app or asset bytes, and is a cache miss.

`checkNegativeProof` re-parses the manifest and **re-validates the StopResult from its own records (H2)** instead of trusting its labels:

- It must be a result that `stopNativeAlpha` issued in this process. Issued results are frozen and registered privately. A copy, a persisted file or a hand-built result is refused. This stops forgery, but it proves no provider origin.
- Its before-state must pass the readback checks at its recorded check time, and its after-state the after checks.
- Its dispatched records must be exactly the reviewed stop plan, once each, in order, all accepted, with valid ordered start and completion times.
- Every time must be on one non-decreasing clock, and the after-state must follow the last completion.

A `network` label with no valid `provenance` (receipt digest, `public-dns` resolver, verified-TLS result) is a HOLD. With a valid provenance it is still self-asserted data. The contract refuses:

- redirects and auth denials (401, 403, 407)
- nonexistent hosts, anonymous requests and host-header emulation
- foreign builds and wrong-client identities
- a HOLD stop

## Checked pipeline handoff

`deploy/probes/target.ts` (`clearcase.deploy-target/1`) cannot yet represent the native product target. It has no zone, custom domain, workers.dev or preview settings, or EU jurisdiction, and its `onlyKeys` refuses `routes` and `workers_dev`. `bindStageRecord` only links a client's `stage.json` (client and artifact digest) to this manifest. It does not replace target → stage → prebuilt. The parent, as serial owner, must extend the checked target and its tests before any native apply. No raw Wrangler apply and no checker bypass are allowed.

## Checks

Run the private list only. It is not part of the root or deployment Vitest include lists:

```sh
scripts/agent-tools/receipt --name native-controls -- bun x vitest run --config tests/hosting-probe/deployment/native-alpha-controls/vitest.config.ts
scripts/agent-tools/receipt --name native-controls-types -- bun x tsc -p tests/hosting-probe/deployment/native-alpha-controls/tsconfig.json
```

## Fix round r1: fixture format changes to the existing tests

The 81 existing tests keep their names and assertions. Only their fixture helpers changed, because the new checks need data the old format could not carry: the readback helper gained `routesComplete`, `accountZones` and `otherZoneRoutes` (one synthetic zone); the stop harness gained a synthetic KNOWN `domainDetachPolicy`; and the canary helper gained `respondedAt` on every observation and `provenance` on `network` ones. The new adverse tests are in `controls-fix-r1.test.ts` (private include list). They failed first on the unchanged module (receipt `native-controls-fix-r1-red2`).

**Resolved by the label correction below.** The result for network-labelled data was first named `NEGATIVE-PROOF-CONTRACT-SATISFIED`, which read stronger than the evidence. The user approved a label-only rename on 25 October 2026 (`.orchestration/reports/cloudflare-alpha-20261024/user-four-bounded-corrections-20261025.md`). The state is now `NETWORK-LABELLED-STRUCTURALLY-CONSISTENT`: the `ProofState` literal, the one return literal, and the two expected-result assertions (`controls.test.ts` and `controls-fix-r1.test.ts`) changed. Test names, logic, negative assertions, flags and claims did not. The result still carries `structuralOnly:true`, `remoteProof:false` and `controlReady:false`. Network and receipt labels are self-asserted and never acquire trust here. Nothing in this module is provider proof, REMOTE CONTROL-READY or a funding decision.

## Addendum: post-RED edits to `controls-fix-r1.test.ts`

The fix-r1 report says its RED commit `8683d9d6` added the new test file with the module unchanged. That file was in fact edited after `8683d9d6`, before the fix commit `30bf0cb9`, and the original report did not disclose it. The fresh recheck (`.orchestration/reports/hosted-48h-20261023/native-custom-domain-controls-fix-recheck-r1.md`) found four edits and ruled each behaviourally neutral and not loosening:

1. The `inventory()` fixture stub was filled in (fixture data).
2. A type cast was changed.
3. `withOther(s) || delete` became `(withOther(s), delete)` (a comma expression).
4. In the provenance-edit test, the assertion target moved from `o[1]` to `o[0]`. Before and after observations share one provenance object, so the change is neutral.

The original reports, receipts and failing history are kept unchanged. This addendum does not claim a retrospective RED.

## Not run

The following have not run: provider calls, any apply, DNS, real canaries, funding, the full build, the gate, workerd and the browser.
