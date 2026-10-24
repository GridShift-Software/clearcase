# Client instances, case grants and authorization (GRS-114)

Status: PREPARED/UNVERIFIED. Source factories, ports and unit tests over synthetic doubles only. Nothing is composed into the hosted runtime; no Clerk, D1, R2, Worker or provisioning run has happened. Production keeps refusing protected requests (503) until the coordinator composes real adapters.

Decisions: [ADR-0007](../adr/0007-hosted-client-isolation-and-identity.md), [ADR-0008](../adr/0008-workers-runtime-and-cloudflare-first-stack.md).

## What exists (`src/lib/tenancy/`)

- `manifest.ts`: `validateClientManifest(input)` checks `{ staffIssuer, clients: [{ clientId, hostname, worker, d1DatabaseId, d1DatabaseName, r2Bucket, clientIssuer }] }`. Fields are exact. No Worker, database, bucket, hostname or issuer may be shared between clients or with staff. There is no client count limit. `resolveDeployment(manifest, { clientId, worker, d1DatabaseId, r2Bucket })` returns the `ClientResourceIdentity` only when the deployment's own Worker, D1 and R2 are exactly that client's. It makes no provider calls.
- `grants.ts`: grant types, the `GrantRepository` port and the `CaseDirectory` port (`exists({ clientId, caseId })`, owned by storage, GRS-115).
- `d1-grants.ts`: `d1GrantRepository(db)` over the `tenant_case_grants` table (`migrations/0001_tenant_case_grants.sql`). The table has no foreign key to any case table.
- `authorizer.ts`: `createCaseAuthorizer({ deployment, grants, cases, audit, now })` returns `{ authorizeCase, authorizeCapability }`.
- `management.ts`: `createGrantManagement({ deployment, grants, cases, audit, now })` returns `{ create, update, revoke }`.

## The frozen callback for GRS-113

```ts
authorizeCase({ principal, sessionId, caseId, operation }): Promise<void>
```

`principal: Principal`, `sessionId: SessionId` and `operation: CaseOperation` are the types in `runtime/contracts.ts`. The client is the deployment's (`deployment.clientId`), never the request's. GRS-113 verifies the token, session and revocation, then calls this function. This module authenticates nothing itself. Refusals are `ContractError`s with these codes:

- `unauthenticated`: no principal or session.
- `wrong-client`: the principal's issuer is not its kind's issuer for this deployment.
- `forbidden`: no effective grant, or an unknown case. Both give the same error, so a refusal reveals no case metadata.
- `identity-unavailable` (retryable): the grant or case lookup failed.
- `audit-unavailable` (retryable): a required staff-access event did not persist.

Identity can implement `Identity.authorize({ caseId, operation })` as `authorizeCase({ principal, sessionId, caseId, operation })`.

## Rules

- Roles are explicit server rows; none come from Clerk metadata.
  - `viewer` covers `read`, `read-original` and `read-preview`.
  - `editor` adds `write-user-work`.
  - `operator` and `publisher` grant no content operation. They are `authorizeCapability` capabilities (`operate`, `publish`) for GRS-28/30/31.
  - `grant-admin` is client-wide. It authorizes grant management only.
- Firm admin, Global Admin and staff membership alone reach no case. Staff reach a case through an explicit case grant. Each staff access appends a `succeeded` event, and the access fails closed if that append fails. Denials append a `denied` event on a best-effort basis; the refusal stands either way.
- A grant counts only when it is `active`, unexpired, of this client, and matches the principal's issuer, subject and kind, and the case. Grants do not depend on publication, so a case is usable before its first publication. Withdrawing results does not touch grants.
- Management requires an active `grant-admin` grant. Nobody can grant to themselves or change their own grants.
  - Every change is compare-and-set on `version` and keyed by `operationId`.
  - Repeating an operation returns `repeated: true`. Reusing an id for another request returns `conflict/operation-reused`.
  - A live grant in the same slot returns `conflict/slot-taken`. Viewer and editor share one slot; operator, publisher and grant-admin each have their own.
- Audit failures:
  - A create is stored `pending` and grants nothing until its audit event persists.
  - An update revokes the old grant and stores its pending replacement in one batch, so the old access ends at once.
  - A revoke takes effect before its event is appended.
  - Each failure returns `audit-pending` (retryable). A retry with the same `operationId` completes it. A stuck pending grant can be revoked.

## Handoffs (coordinator / owners)

- **Coordinator**:
  - Add `tests/hosted-foundation/provisioning/**/*.test.ts` to the root `vitest.config.ts` include. Until then, run `vitest run -c tests/hosted-foundation/provisioning/vitest.config.ts`.
  - Apply `src/lib/tenancy/migrations/0001_tenant_case_grants.sql` in each client D1.
  - Compose `resolveDeployment` from trusted deployment configuration, then the authorizer, then the GRS-113 provider in `hosted/services.ts`.
  - Provide the reviewed per-client route contract for any management UI. No routes are added here.
  - Add a provisioning-only bootstrap for each client's first `grant-admin`. Tests seed it directly.
- **GRS-113**: inject `authorizeCase` and supply the verified `Principal` and `SessionId` only.
- **GRS-115**: implement `CaseDirectory.exists` over its own case schema.
- **GRS-116**: the event shapes are `case.<operation>` and `grant.create|update|revoke`, with object kinds `case` and `case-grant`. Management event ids are `grant-op:<operationId>`, so a retry may append the same id again; GRS-116 should treat that as idempotent.

## Checks

From the repository root, with `svelte-kit sync` already run:

```sh
scripts/agent-tools/receipt --base b6e4ef39ee52aef8be14c2cc1141d438a9673a56 --name grs114-green -- node_modules/.bin/vitest run -c tests/hosted-foundation/provisioning/vitest.config.ts
```

These are unit tests over node:sqlite and in-memory doubles. They are not D1, Clerk or provisioning evidence. The two-client staging proof, direct-request role tests and the full gate remain UNRUN.
