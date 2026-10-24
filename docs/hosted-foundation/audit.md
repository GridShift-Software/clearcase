# Native request audit log (GRS-116, prepared)

Status: PREPARED/UNVERIFIED. Unit tests run over a node:sqlite stand-in for D1. Nothing here has run against D1, workerd, Clerk or a deployed client. The parent owns composition, schema aggregation and real-boundary proof.

## What it is

`src/lib/audit/` is a D1 adapter for the existing `AuditSink` contract in `src/lib/server/runtime/contracts.ts`. It keeps the existing `AuditEvent` and `IdentityState` unchanged: an actor is anonymous or verified. It adds a trusted `find(eventId)` and permission-scoped, paginated queries. No route appends events and no public append endpoint exists. Server code builds every event.

## Surface (`src/lib/audit/index.ts`)

- `auditConfig({clientId, trustedIssuers, limits})` validates trusted deployment configuration and throws `TypeError` when it is unusable. `trustedIssuers` must be 1 to 8 distinct `https:` issuer URLs. Each limit must be an integer under a hard ceiling (`CEILINGS`): `maxEventBytes` ≤ 4096, `maxRows` ≤ 50,000,000 per client table, `maxPageRows` ≤ 200 and `maxPagesPerRequest` ≤ 20. These are storage and read bounds. None is a spending cap, and none is global across clients.
- `provisionAuditBinding({db, config, now})` binds an empty audit database to its client once. It is for trusted provisioning only. It refuses a database bound to another client.
- `createD1AuditLog({db, config, requester, gate, now})` returns `{append, find, query}`. It is built once per request.
  - `requester` is the request's `IdentityState` as GRS-113 established it. The log validates its shape and checks the issuer against `trustedIssuers`. It never authenticates or mints a verified identity.
  - `gate: AuditReadGate` is required (`TypeError` without it). `caseAudit({principal, sessionId, caseId})` and `administrationAudit({principal, sessionId})` resolve only when the reader holds the grant.
- `AUDIT_MIGRATIONS` lists `src/lib/audit/migrations/0001_native_audit.sql`.

## Storage

Each client's own D1 database holds `native_audit_binding` (one row: the client id and a row counter) and `native_audit_events`. No other table is involved, there is no foreign key, and no `rs_*` or `tenant_*` name is used. Each row stores the canonical JSON envelope `{"envelope":1,"event":{...}}` (keys sorted at every depth) and its SHA-256. The other columns index the same values. Triggers refuse an update or delete of events, an insert for a client that is not bound, and any rebinding of the client. Every statement names the configured `client_id`.

## Behaviour

- **Event shape.** An event must have exactly the `AuditEvent` keys. Every string is a bounded identifier pattern, so free text, note bodies, secrets, JWTs and raw requests are refused as `invalid-event`. The same applies to an oversize envelope and to an actor that is not the requester. For a verified requester, the issuer, subject and kind must be equal; the session may differ, so a retry after a lost acknowledgement from a later session still matches. An anonymous requester may append only anonymous events.
- **Append.** The adapter inserts with `ON CONFLICT(event_id) DO NOTHING`, guarded by the row budget, then always reads back the stored row. Only a stored row with byte-identical canonical JSON and digest acknowledges `{eventId}`. The same id with a different event is refused as `audit-conflict`. A failed insert is never taken as success or failure on its own: a lost acknowledgement whose row did persist still acknowledges after read-back. No stored row means `audit-unavailable`, retryable unless the row budget is spent. The caller must refuse the protected action on any rejection.
- **find(eventId)** is trusted and internal (for GRS-114's `GrantAuditPort`). It returns the stored event exactly as persisted, or `null`. A row whose bytes do not match their digest gives `audit-unavailable`.
- **Unbound or foreign database.** A database without its binding row, or bound to another client, refuses every append, find and query with `audit-unavailable`. The first request never binds it.
- **Queries.** `query({scope, cursor, limit})`:
  - An anonymous reader gets `unauthenticated`. A bad cursor or limit gets `invalid-query`. A request past `maxPagesPerRequest` gets `audit-budget`.
  - The gate decides access. Any denial maps to a uniform `forbidden`, so an unknown case and a case without a grant cannot be told apart. A non-denial failure gives `identity-unavailable`.
  - Each attempt appends one `audit.read` event over `audit-log` (`case` or `administration`). A denial event carries `caseId: null`. A served read appends its event first and returns no rows unless that append is acknowledged. A denial's event is attempted once and never retried; reading does not append per row, so reads cannot recurse.
  - The case scope returns only that case's events. The administration scope returns only events with `caseId` null whose object kind is not `case`, which hides case activity from grant administrators and the Global Admin. Feature owners must set `caseId` on every event about case content.

## D1 semantics assumed, not proven here

The stand-in is SQLite, which D1 is built on. The following are assumptions until the parent's D1 run proves them: triggers with `RAISE(ABORT, …)`, `INSERT … SELECT … ON CONFLICT DO NOTHING`, `AUTOINCREMENT` ordering, and that a statement whose response is lost may still have committed (the read-back handles both cases).

## Parent handoffs

1. Add `tests/hosted-foundation/audit/**/*.test.ts` to the root Vitest include. Until then run `bunx vitest run -c tests/hosted-foundation/audit/vitest.config.ts`.
2. Apply `0001_native_audit.sql` to each client's D1 and call `provisionAuditBinding` from trusted provisioning.
3. Compose `createD1AuditLog` per request in `hosted/services.ts` as `RequestServices.audit`, and as GRS-114's `GrantAuditPort` (append + find).
4. Supply an `AuditReadGate` backed by GRS-114 case grants and administration roles.
5. Feature owners instrument their own events. Routes or UI for audit views are not built here.

## PENDING: control-plane actor

GRS-114's bootstrap uses a synthetic verified actor (`control-plane:<clientId>`). This adapter refuses it: the issuer is not an `https:` trusted issuer. Extending `IdentityState`/`AuditEvent` with a system or control-plane actor, and deciding how it is attributed, is a PENDING coordinator/user decision. There is no fallback.
