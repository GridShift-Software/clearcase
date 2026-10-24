# Native alpha custom-domain controls

Status: **PREPARED / UNVERIFIED**. The local plan and its unit tests exist. No remote control has run, so nothing here is REMOTE CONTROL-READY, provider proof or a funding decision.

## Why this is new

The GRS-203 stop sends only `POST /accounts/<account>/workers/scripts/<worker>/subdomain` with `{enabled:false, previews_enabled:false}`, and it refuses any non-empty `publicRoutes`. Within that closed-ingress contract it is complete, and this document makes no claim that it fails its own spec. The native alpha, however, serves clients on Workers custom domains (`a.sandbox.gridshift.co.za` and `b.sandbox.gridshift.co.za`), which the GRS-203 stop cannot unbind. `deploy/native-alpha/controls.ts` adds that capability as a separate module. It does not edit GRS-203, `deploy/probes/**`, `cloud-run.ts` or the janitor.

## Evidence states

| State | Meaning | Who reaches it |
| --- | --- | --- |
| LOCAL-PLAN-VERIFIED | The private unit tests pass at an exact SHA, with injected data only | This module |
| `UNIT-CONTRACT-ONLY` | Canary data satisfies the contract shape, but at least one observation is injected | `checkNegativeProof` |
| `NEGATIVE-PROOF-CONTRACT-SATISFIED` | Observations labelled `network` satisfy the contract. They are still data until the parent binds them to receipts | `checkNegativeProof` |
| REMOTE CONTROL-READY | The parent has a funded manifest, a scoped apply, a fresh provider readback and authenticated real negative canaries at an exact SHA | Parent only, not run |
| FUNDED | An all-in allocation within USD 10, with retention accepted by the user | User/parent only, not decided |

`StopResult.providerProof` and `controlReady` are always `false`. `retainedStorageBills` is always `true`: D1, R2 and Worker versions are retained, and they keep billing after ingress stops. No hard cap on money is claimed.

## Manifest (`clearcase.native-alpha-controls/1`)

Every client must belong to `APPROVED_NATIVE_SCOPE`: account `fb4c31b91c5d89b7a54afbdc34823170` and zone `gridshift.co.za` / `db7c322907320aba562d64015ee7d673`, with that client's approved Worker, hostname, D1 name and R2 bucket. The current plan has two clients, but that comes from the scope list. The code has no fixed client count. Each client entry has exactly these keys:

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
  - the zone's `workers/routes`
  - per Worker: `subdomain`, `versions`, `deployments` and `secrets`
  - `d1/database/{id}`
  - `r2/buckets/{bucket}`, plus its `domains/managed` and `domains/custom`, each with `cf-r2-jurisdiction: eu`

### Unverified side effects

Detaching a domain may also remove its DNS record or certificate. The SDK text does not state these effects, so they are an open gap. Real re-attach timing is also unverified. Wrangler internally reads `workers/domains/records` and posts `scripts/{name}/domains/changeset`, and its records carry `enabled` and `previews_enabled`. That could allow a non-delete domain disable, but these endpoints are absent from the SDK, so they are not used. Workers routes have no reviewed non-destructive disable. Any route that runs on an owned Worker or covers an owned hostname therefore causes a HOLD; routes are never deleted.

## Stop orchestration (`stopNativeAlpha`)

The caller injects `now`, `stopOwnerRequests`, `readState` and `dispatch`. There are no defaults, environment reads, timers or imports.

1. The manifest is copied and frozen before the first await.
2. New owner requests are stopped first.
3. The before-state must be complete, fresh (no more than 60 s old) and exact, with each reviewed domain bound once and no other domain or route exposure.
4. Each planned operation is dispatched once, with no retry and no fallback.
5. The after-state is read fresh, and its timestamp must be later than the dispatch. It must show no owned domain bound, workers.dev and previews both false, and identical retained versions, secret names, EU D1 and private EU R2.
6. A missing callback, failed dispatch, partial disable, stale or unknown state, unreadable after-state or throwing clock ends in a HOLD. The result records what was dispatched, and the uncertain liability is retained. Comparisons ignore the provider's key order.

## Negative-proof contract (`checkNegativeProof`)

The contract needs, for each client's custom domain, both an app canary and an original-asset canary:

- **Before**: an authenticated request as that client, resolved through public DNS with a matching TLS hostname, returns 200. The app canary must serve the deployed `sourceSha`, and the asset canary the deployed `assetSha256`.
- **After**: a request taken after the after-readback ends in a classified network error, or in an error response that carries no build, no app or asset bytes, and is a cache miss.

`checkNegativeProof` re-parses the manifest and re-checks the stop's after-state. The contract refuses:

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

## Not run

The following have not run: provider calls, any apply, DNS, real canaries, funding, the full build, the gate, workerd and the browser.
