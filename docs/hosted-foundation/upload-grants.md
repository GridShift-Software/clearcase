# Case upload grant: `case.upload-originals` (NATIVE24)

Status: PREPARED/UNVERIFIED. Source factories, a migration and unit tests over node:sqlite stand-ins and in-memory doubles. No D1, Clerk, audit-log, Worker or provisioning run has happened, and nothing is composed into the hosted runtime: the intake still answers 503 until the parent composes an authorizer. This is a separate scope from [GRS-114 grants](provisioning.md); it changes none of that source, its actor logic, its contracts or its audit.

## What it is

An explicit, server-held row for the exact tuple **(client, case, issuer, subject, principal kind)**. It is not a role of `tenant_case_grants`, so no viewer, editor, operator, publisher, grant-admin, staff or firm-admin identity implies it, and it implies none of them. It confers no read, no write-user-work, no operate and no publish, and it does not stand in for the cost, provider or financial grants of the CF ceiling (unchanged: about USD 10, no new grant).

## Files

- `src/lib/tenancy/upload-capability.ts` (request side, exported from the index): `createUploadAuthorizer(options | null)`, `d1UploadGrantReader(db, deployment)`, `uploadEffective`, types, `UPLOAD_GRANT_MIGRATIONS`. Reads only.
- `src/lib/tenancy/upload-provisioning.ts` (provisioning only, **not** exported): `bindUploadDatabase(db, deployment)` and `createUploadProvisioning({ deployment, db, cases, audit, now })` returning `{ grant, revoke }`.
- `src/lib/tenancy/migrations/0003_tenant_upload_grants.sql`: additive. Apply after 0001 and 0002, in each client's own D1.
- `index.ts` gains the request-side export only. `TENANCY_MIGRATIONS` is unchanged (still 0001 and 0002); apply `UPLOAD_GRANT_MIGRATIONS` as well.

## Runtime: `authorizeUpload`

`createUploadAuthorizer` returns a function that is structurally the intake's `AuthorizeUpload` (`{ principal, sessionId, clientId, caseId } => Promise<void>`), or `null` for `null` or `undefined` options (the intake then answers 503). A configured authorizer missing any dependency throws `TypeError` at construction; it never degrades to allowing. Dependencies: the deployment identity, the 114 `grantsOf` (explicit case access), the upload reader, the case directory, a session check, a request `AuditSink` and a clock.

Allowed only for a verified principal of this deployment with a live session, an effective explicit case grant that permits `read` (viewer or editor), **and** an active, unexpired upload grant, on a case that exists. Then an access event (`case.upload-originals`, `succeeded`, verified actor) must be acknowledged, or the call fails closed.

| Condition | Error | Intake answer |
| --- | --- | --- |
| no principal or session | `unauthenticated` | 401 |
| session revoked or expired (the session check rejects `invalid-session`) | `invalid-session` | 401 |
| `clientId` argument is not the deployment's; principal not its kind's principal of this deployment | `wrong-client` | 401 |
| no case access, no upload grant, revoked, expired, pending, other case, other tuple, unknown case | `forbidden` (one error, same message) | 403 |
| session check, grant lookup, case lookup, unbound or foreign database fails | `identity-unavailable` (retryable) | 503 |
| the access event does not persist | `audit-unavailable` (retryable) | 503 |

Both grant lookups always run, so a refusal's shape never says which grant was missing. A denial event is scoped to the case only when the principal already holds case read access to a case that exists; otherwise `caseId` is null.

## Provisioning

Trusted, non-request only. There is no HTTP route, manager, grant-admin or Global Admin path to it. `grant({ operator, operationId, target: { issuer, subject, kind }, caseId, expiresAt })` and `revoke({ operator, operationId, grantId, expectedVersion })`.

- The target must be a principal of this client (its client issuer) or of staff (the staff issuer). `control-plane:` issuers, the `control-plane` kind, empty subjects and unknown cases are `invalid`.
- The ledger actor is `control-plane:<clientId>` plus the `operator` label. The audit event actor is the honest system actor `{ kind: 'system', component: 'provisioning', operator }`: no principal, issuer or session. It is attribution only and confers no identity privilege.
- Event: `upload-grant-op:<operationId>`, action `grant.upload.issue` or `grant.upload.revoke`, object `upload-grant` with the case id.
- The audit port must have `append` and `find`. An issue stays `pending` (granting nothing) until `find` returns the byte-identical event, or an append is acknowledged, or a read-back after a lost acknowledgement matches. A different event under the id is `conflict/audit-mismatch`. Only then does the ledger row become `audited` and the grant `active`. A revoke takes effect first and its event is confirmed after.
- Idempotent on the operation id, bound to operator, type and request (`conflict/operation-reused` otherwise). One live grant per tuple (`conflict/slot-taken`). Revoke is compare-and-set on `version`. Storage faults are retryable `storage-unavailable`; only a constraint violation is a lost race.

## What the database enforces

- **Pin.** `tenant_upload_binding` is a single, immutable row naming the client and D1 database id, written only by `bindUploadDatabase` (provisioning). Every query and write first checks it; an empty, missing or foreign binding is a fault and a request never binds. Grant rows must name the bound client (trigger).
- **No activation before ack.** A grant is inserted `pending` and activates only when its `issue` ledger row is `audited` (trigger and the update's own condition). A revoked row never revives; a grant's tuple and its ledger rows can never be changed or deleted; the ledger records only `control-plane` actors. The reader also requires the audited issue row, so a forged `active` row is nothing.

## Handoffs

- **Coordinator**: apply 0003 after 0001 and 0002; run `bindUploadDatabase` once per client from provisioning; run `grant` and `revoke` from provisioning only (who may, and under what review, is the coordinator's policy); compose `createUploadAuthorizer` with the GRS-113 session check, the 114 repository, the GRS-115 case directory and the GRS-116 request sink, and pass it to the intake as `authorizeUpload`. Add `tests/hosted-foundation/upload-grant/**/*.test.ts` to the root vitest `include`.
- **Import guard (GuardParent)**: `scripts/ci/hosted-imports.ts` names the 114 provisioning modules but not `src/lib/tenancy/upload-provisioning.ts`. It needs the same rule (fail any hosted-graph edge, deep import, re-export or dynamic import) before this is composed. Not changed here. Until then only a source-text test (`database.test.ts`, boundaries) keeps it out of the index and the other tenancy modules.
- **Docs**: `native-integration-contracts.md` still says "no authorizer, grant writer"; update it when this lands.

## Checks

```sh
scripts/agent-tools/receipt --base e571558f17fde8781cf01f16ff04971adeb873de --name native24-upload-green -- node_modules/.bin/vitest run -c tests/hosted-foundation/upload-grant/vitest.config.ts
node_modules/.bin/tsc -p tests/hosted-foundation/upload-grant/tsconfig.json
```

The focused config's `include` replaces the root list. node:sqlite is a durable-SQLite stand-in with D1's one-transaction batch, not D1 provider proof. The real-D1 two-client proof, the audit-log adapter, the hosted import guard rule, the full suite and the gate are UNRUN.
