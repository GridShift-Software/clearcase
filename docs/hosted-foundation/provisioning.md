# Client instances, case grants and authorization (GRS-114)

Status: PREPARED/UNVERIFIED (security fix round 1 applied over the HOLD review of 3ff8f923; system-actor supplemental correction applied at f8d2b7b3 plus descendant commits). Source factories, ports and unit tests over synthetic doubles only. Nothing is composed into the hosted runtime; no Clerk, D1, R2, Worker or provisioning run has happened. Production keeps refusing protected requests (503) until the coordinator composes real adapters.

Decisions: [ADR-0007](../adr/0007-hosted-client-isolation-and-identity.md), [ADR-0008](../adr/0008-workers-runtime-and-cloudflare-first-stack.md).

## What exists (`src/lib/tenancy/`)

- `manifest.ts`: `validateClientManifest(input)` checks `{ staffIssuer, clients: [{ clientId, hostname, worker, d1DatabaseId, d1DatabaseName, r2Bucket, clientIssuer }] }`. Fields are exact. No Worker, database, bucket, hostname or issuer may be shared between clients or with staff. There is no client count limit. `resolveExactDeployment(manifest, { clientId, hostname, worker, d1DatabaseId, d1DatabaseName, r2Bucket })` is the production form: every field is required and compared exactly, and a missing, extra, empty or foreign one refuses. `resolveDeployment` is the older, lenient form (hostname and D1 name checked only when supplied). Neither makes provider calls, so neither proves the platform bound those resources. Principal issuers are compared as exact strings; nothing normalizes them.
- `grants.ts`: grant types, the `GrantRepository` port and the `CaseDirectory` port (`exists({ clientId, caseId })`, owned by storage, GRS-115).
- `d1-grants.ts`: `d1GrantRepository(db)` over the `tenant_case_grants` table (`migrations/0001_tenant_case_grants.sql`). The table has no foreign key to any case table.
- `authorizer.ts`: `createCaseAuthorizer({ deployment, grants, cases, audit, now })` returns `{ authorizeCase, authorizeCapability }`.
- `management.ts`: `createGrantManagement({ deployment, grants, cases, audit, now })` returns `{ create, update, revoke }`. The bootstrap, `createManagerBootstrap({ deployment, grants, audit, now })` returning `{ grantManager }`, lives in `provisioning.ts`: provisioning only, not exported from the tenancy index, and no hosted module may import it (below).
- `audit.ts`: the `GrantAuditPort` (`AuditSink` plus `find(eventId)`), the `ProvisioningAuditPort` (a system-event `append` plus `find`, for the bootstrap only), canonical JSON and the SHA-256 digest used to compare events.
- `operations.ts`: internal. The operation ledger and settle step that `management.ts` and `provisioning.ts` share. Not exported from the index; it confers no authority.
- `migrations/0002_tenant_grant_operations.sql`: the operation ledger, additive. `tenant_case_grants`, its grant ids and constraints are untouched.

## The frozen callback for GRS-113

```ts
authorizeCase({ principal, sessionId, caseId, operation }): Promise<void>
```

`principal: Principal`, `sessionId: SessionId` and `operation: CaseOperation` are the types in `runtime/contracts.ts`. The client is the deployment's (`deployment.clientId`), never the request's. GRS-113 verifies the token, session and revocation, then calls this function. This module authenticates nothing itself. Refusals are `ContractError`s with these codes:

- `unauthenticated`: no principal or session.
- `wrong-client`: the principal's issuer is not its kind's issuer for this deployment.
- `forbidden`: no effective grant, or an unknown case. Both give the same error, so a refusal reveals no case metadata.
- `identity-unavailable` (retryable): the grant or case lookup failed.
- `audit-unavailable` (retryable): the required access event did not persist.

Identity can implement `Identity.authorize({ caseId, operation })` as `authorizeCase({ principal, sessionId, caseId, operation })`.

## Rules

- Roles are explicit server rows; none come from Clerk metadata.
  - `viewer` covers `read`, `read-original` and `read-preview`.
  - `editor` adds `write-user-work`.
  - `operator` and `publisher` grant no content operation. They are `authorizeCapability` capabilities (`operate`, `publish`) for GRS-28/30/31.
  - `grant-admin` is client-wide. It authorizes grant management only.
- Firm admin, Global Admin and staff membership alone reach no case. Staff reach a case through an explicit case grant.
- Audit of access: every allowed access, client or staff, appends a `succeeded` event with the verified actor, and is allowed only after that append is acknowledged. With the log unavailable no case is reachable. Every denial of a verified principal appends a best-effort `denied` event, and the refusal stands either way.
- A denial event carries `object.caseId` only when the principal holds an effective grant on a case that exists. For no grant, an unknown case or a foreign client, `caseId` is null, so a caller cannot plant events in a case's audit scope or tell an unknown case from one it lacks a grant on. `object.id` echoes the requested id only when it is well-formed (else `invalid`).
- A grant counts only when it is `active`, unexpired, of this client, and matches the principal's issuer, subject and kind, and the case. Grants do not depend on publication. Withdrawing results does not touch grants.
- Management requires an active `grant-admin` grant. Nobody can grant to themselves or change their own grants.
  - Management authority is not bestowable by a manager. `create` and `update` refuse any `grant-admin` grant (new, or a role change into it) and any change of an existing one, each with a denial event. Revoking a grant, including a grant-admin one, stays allowed.
  - Explicit case grants by independently authorised managers are legitimate. This code cannot tell whether two humans collude, and does not claim to; there is no two-person rule.
  - The first and every further `grant-admin` comes from `createManagerBootstrap`. It is a trusted control-plane factory: provisioning composes it from deployment configuration in a provisioning job, and request-serving code must not import it. Its ledger actor is the label `control-plane:<clientId>` plus the caller's `operator` string (not a verified identity, and it authorizes nothing). Its audit actor is the system actor `{ kind: 'system', component: 'provisioning', operator }`: no principal, session, issuer or verified claim, so no reader that filters verified staff can mistake it for a person (GRS-114 supplemental correction, 25 October 2026). It is not an `IdentityState` and confers no capability; request identities stay `anonymous | verified`. The bootstrap needs a `ProvisioningAuditPort` (`audit/provisioning.ts`), which is the only port that can record a system actor. Request ports (`requestAuditSink`, the grant port, the log) refuse it as `invalid-event`. It grants only `grant-admin`, client-wide, with the same pending, audit, idempotency and binding rules.
  - Every change is compare-and-set on `version` and keyed by `operationId`. An operation id is bound to the client, the actor principal (issuer, subject, kind), the operation type and the canonical request that first used it. Another actor, type or request gets `conflict/operation-reused` and nothing of the original. The same principal on a new session resumes, with the original event.
  - A live grant in the same slot returns `conflict/slot-taken`. Viewer and editor share one slot; operator, publisher and grant-admin each have their own.
- Audit and retries. The operation ledger (`tenant_grant_operations`) is written in the same D1 batch as the change. It fixes the event (actor, session, instant, canonical JSON and digest) before any append, and a retry uses that row, never a rebuilt event.
  - The event is confirmed by `find(eventId)` first, by `append` when absent, and by reading back after a failed append. Only a stored event whose canonical bytes equal the recorded ones counts. A duplicate error or an error string proves nothing. A different event under the id gives `conflict/audit-mismatch` and the grant stays pending.
  - A create or update is stored `pending` until its event is confirmed, then activates. An update revokes the old grant and stores its pending replacement in one batch. A revoke takes effect first and its event is confirmed after. Each unconfirmed case returns `audit-pending` (retryable). A confirmed (`audited`) operation never appends again, and a replay reports the grant as it now is (a revoked grant is reported revoked). A never-confirmed create or update whose grant was revoked meanwhile returns `stale`.
  - D1 failures surface as `storage-unavailable` (retryable). Only a constraint violation counts as a lost race or taken slot.

## Handoffs (coordinator / owners)

- **Coordinator**:
  - Add `tests/hosted-foundation/provisioning/**/*.test.ts` to the root `vitest.config.ts` include. Until then, run `vitest run -c tests/hosted-foundation/provisioning/vitest.config.ts`.
  - Apply `src/lib/tenancy/migrations/0001_tenant_case_grants.sql` and `0002_tenant_grant_operations.sql`, in that order, in each client D1.
  - Compose `resolveExactDeployment` from trusted deployment configuration, then the authorizer, then the GRS-113 provider in `hosted/services.ts`.
  - Provide the reviewed per-client route contract for any management UI. No routes are added here.
  - Call `createManagerBootstrap(...).grantManager` (from `src/lib/tenancy/provisioning.ts`, with `provisioningAuditPort` from `src/lib/audit/provisioning.ts`) from provisioning only, for each client's first `grant-admin`. Tests seed it directly. Who may run it, and under what review, is the coordinator's policy decision; nothing here proves it.
- **GRS-113**: inject `authorizeCase` and supply the verified `Principal` and `SessionId` only.
- **GRS-115**: implement `CaseDirectory.exists` over its own case schema.
- **GRS-116**: the event shapes are `case.<operation>` and `grant.create|update|revoke|bootstrap`, with object kinds `case` and `case-grant`. Management event ids are `grant-op:<operationId>`. Provide the D1 adapter for `GrantAuditPort`: `append` over the unchanged global sink, and `find(eventId)` reading back the stored event over the same table. `event_id` must stay a primary key; the exactly-once guarantee rests on that uniqueness plus `find`. Management and the bootstrap throw at construction without `find`: a plain append-only sink cannot prove whether a lost acknowledgement persisted, so there is no recovery without it. The global `AuditSink` is not changed.

## Checks

From the repository root, with `svelte-kit sync` already run:

```sh
scripts/agent-tools/receipt --base b6e4ef39ee52aef8be14c2cc1141d438a9673a56 --name grs114-green -- node_modules/.bin/vitest run -c tests/hosted-foundation/provisioning/vitest.config.ts
```

These are unit tests over node:sqlite and in-memory doubles. They are not D1, Clerk or provisioning evidence. The two-client staging proof, direct-request role tests and the full gate remain UNRUN.

## Disclosure addendum: three post-RED test corrections in security-fix.test.ts (GRS-114)

Source: the fix-round-1 recheck (`native-grs114-fix-recheck-r1`) and a byte-for-byte rerun of the RED file from 5dca8304 against current source. After RED, three tests were corrected and the change was not disclosed at the time. This records it. The original RED commit, its receipts and this history are preserved, and nothing is retrospectively called an adverse-first result.

| Test | Why the RED version was defective | Actual failure of the unmodified RED test on the fixed source |
|---|---|---|
| H1 `denied` filter | Its denied-event list was unfiltered, but the base already audited a `case.write-user-work` denial. The filter gained the same `grant.` prefix (`e.action.startsWith('grant.')`). | `expected [Array(4)] to deeply equal [Array(3)]` |
| M1 `createdBy: admin` | The stored `createdBy` is `{ issuer, subject }` and has no `kind`, so `toMatchObject(admin)` could never match. It now names `{ issuer, subject }`. | `expected { kind: 'applied', … } to match object { kind: 'applied', … }` |
| M1 revoke leg | It revoked a grant that the preceding update had already superseded. That gave `stale`, and `toBeDefined()` masked it. It was split into separate update and revoke tests that assert `audit-pending`, the other manager's `operation-reused`, and the original actor's resume. | `expected { kind: 'stale' } to deeply equal { kind: 'conflict', … }` |

The recheck ruled each edit a correction of a RED-test defect that does not loosen the protected contract. It also ruled the separate edit to `management.test.ts:58` a PASS. Probe: the unmodified RED file gives 3 failed and 13 passed at the fixed source.
