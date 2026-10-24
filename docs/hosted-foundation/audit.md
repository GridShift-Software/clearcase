# Native request audit log (GRS-116, prepared)

Status: PREPARED/UNVERIFIED (fix round 1 applied). Unit tests run over a node:sqlite stand-in for D1. Nothing here has run against D1, workerd, Clerk or a deployed client. The parent owns composition, schema aggregation and real-boundary proof.

## What it is

`src/lib/audit/` is a D1 adapter for the existing `AuditSink` contract in `src/lib/server/runtime/contracts.ts`. It keeps the existing `AuditEvent` and `IdentityState` unchanged: an actor is anonymous or verified. It adds a trusted `find(eventId)` and permission-scoped, paginated queries. No route appends events and no public append endpoint exists. Server code builds every event.

## Surface

Three entry points, each handing out the least it can. The parent composes them; it never hands a request route the full log.

- **Public barrel `src/lib/audit/index.ts`** (safe to import from server code that composes a request):
  - `auditConfig({clientId, trustedIssuers, limits})` validates trusted deployment configuration and throws `TypeError` when it is unusable. `trustedIssuers` must be 1 to 8 distinct `https:` issuer URLs. Every limit is required and is an integer under a hard ceiling (`CEILINGS`): `maxEventBytes` ≤ 4096, `maxRows` ≤ 50,000,000 (protected events), `maxReadRows` ≤ 50,000,000 (served reads), `maxDenialRows` ≤ 1,000,000 (refused or failed reads, all actors), `maxDenialsPerActor` ≤ 1,000, `maxPageRows` ≤ 200 and `maxPagesPerRequest` ≤ 20. These are storage and read bounds. None is a spending cap, and none is global across clients.
  - `requestAuditSink({db, config, requester, now})` returns a frozen `{append}` and nothing else. It is the object for `RequestServices.audit`.
  - `publicAuditReader({db, config, requester, gate, now})` returns a frozen `{query}` for the audit view route only. `gate: AuditReadGate` is required (`TypeError` without it): `caseAudit({principal, sessionId, caseId})` and `administrationAudit({principal, sessionId})` resolve only when the reader holds the grant.
  - Types (`RequestAuditSink`, `PublicAuditReader`, `PublicAuditEvent`, `PublicAuditPage`, `AuditReadGate`, `AuditQuery`, `AuditScope`, `AuditConfig`) and `AUDIT_MIGRATIONS`.
  - `requester` is the request's `IdentityState` as GRS-113 established it. The log validates its shape and checks the issuer against `trustedIssuers`. It never authenticates or mints a verified identity.
- **Trusted entry `src/lib/audit/trusted.ts`** (trusted composition and provisioning only; never a route, feature module or UI):
  - `trustedGrantAuditPort({db, config, requester, now})` returns a frozen `{append, find}` for GRS-114's `GrantAuditPort`.
  - `provisionAuditBinding({db, config, now})` binds an empty audit database to its client once, and refuses a database bound to another client.
  - `createD1AuditLog(...)` is the full internal log (`append`, `find`, `query`). It exists for composition and tests. It must never be passed to a route.
- **Internal core `d1-log.ts`**: not for import outside this folder.

The parent's hosted-imports rule must restrict importers of `trusted.ts` (and of `d1-log.ts`). This change does not edit shared files, so that rule is a handoff.

## Storage

Each client's own D1 database holds `native_audit_binding` (one row: the client id and four counters) and `native_audit_events`. No other table is involved, there is no foreign key, and no `rs_*` or `tenant_*` name is used. Each row stores the canonical JSON envelope `{"envelope":1,"event":{...}}` (keys sorted at every depth) and its SHA-256. The other columns index the same values. Every statement names the configured `client_id`.

Each event has a class. `protected` is a business event a producer appended (counted in `event_count`, bounded by `maxRows`). `read` is a served `audit.read` (`read_count`, `maxReadRows`). `denial` is a refused or failed `audit.read` (`denial_count`, `maxDenialRows`, plus `maxDenialsPerActor` by actor key, a digest of issuer and subject). A table `CHECK` ties each class to its action and outcome, and only the log writes the `audit.read` action.

Constraints and triggers (plain SQLite, not PRAGMA settings): `BEFORE INSERT` refuses an event whose id or sequence is already stored, so `INSERT OR REPLACE` cannot swap a row with `recursive_triggers` on or off; the binding row is inserted once with zeroed counters (so `INSERT OR REPLACE` cannot rebind it); `client_id`, `bound_at` and the singleton key are fixed; a counter never decreases and one statement raises the counters by at most one in total; events have no update and no delete; an event for a client that is not bound is refused.

**Threat boundary.** This stops accidental or unreviewed DML from rewriting history, rebinding the client or resetting a quota. It does not stop a SQL administrator who can `DROP` a trigger or table or replace the database, and a direct `+1` on a counter is still possible. This is not tamper-proof and the log makes no such claim. The `native_audit_binding` counters are what an operator reads for capacity.

## Behaviour

- **Event shape.** An event must have exactly the `AuditEvent` keys. Every string is a bounded identifier pattern and the envelope is size-limited, which narrows what can ride in an event. It does not make a secret impossible: an identifier pattern cannot tell a UUID, an opaque token or a bearer secret from an id. The producer must be trusted, must use opaque identifiers and must never put a secret, token or case content in an identifier field. Violations of shape give `invalid-event`, as does an actor that is not the requester or the reserved `audit.read` action. For a verified requester the issuer, subject and kind must be equal; the session may differ, so a retry after a lost acknowledgement from a later session still matches. An anonymous requester may append only anonymous events.
- **Append.** The adapter inserts only if the id is absent and the `protected` capacity is not spent, then always reads back the stored row. Only a stored row with byte-identical canonical JSON and digest acknowledges `{eventId}`. The same id with a different event is refused as `audit-conflict`. A failed insert (a lost acknowledgement, or the schema refusing a racing duplicate) is never taken as success or failure on its own: the read-back decides. No stored row means `audit-unavailable`, retryable unless the class budget is spent. The caller must refuse the protected action on any rejection.
- **find(eventId)** is trusted and internal (for GRS-114's `GrantAuditPort`). It returns the stored event exactly as persisted, session included, so 114 can compare bytes. A row whose bytes do not match their digest gives `audit-unavailable`. It is not on the request sink or the public reader.
- **Unbound or foreign database.** A database without its binding row, or bound to another client, refuses every append, find and query with `audit-unavailable`. The first request never binds it.
- **Queries.** `query({scope, cursor, limit})`:
  - An anonymous reader gets `unauthenticated`. A bad cursor or limit gets `invalid-query`. Every attempt, denied or not, counts towards `maxPagesPerRequest`; past it the reader gets `audit-budget`.
  - The gate decides access. A real refusal is a uniform `forbidden` (an unknown case and a case without a grant cannot be told apart). A gate or backend fault is `identity-unavailable`, fails closed and is recorded as outcome `failed`, not `denied`.
  - A served read first appends one `read` event and returns no rows unless that append is acknowledged. A refused or failed read attempts one `denial` event, never retried. A denial event carries `caseId: null`.
  - **Audit completeness limits.** Reads and denials are charged to their own budgets, so no reading, authorised or not, can use up the protected-event capacity or disable the client. When `maxReadRows` is spent, reads fail closed with `audit-unavailable` (never an unlogged read) while protected appends continue. When a denial cannot be stored (the overall or per-actor bound, or a storage fault), the read is still refused, uniformly, and `denial_unlogged` is incremented. The denial record is therefore bounded evidence, not a census of attempts, and it is not an authentication throttle. Cross-request rate limiting of one actor or address is a parent handoff. Retention or archival that frees capacity once a budget is spent is also a parent or operator decision. This round sets no global spending cap and no new product policy.
  - The case scope returns only that case's events. The administration scope returns only events with `caseId` null, a non-case object kind and no version. Feature owners must set `caseId` on every event about case content.
  - **Public event shape.** A query returns `PublicAuditEvent`, built field by field: `eventId`, `action`, `object`, `version`, `outcome`, `at`, and an `actor` of `{kind: 'anonymous'}` or `{kind: 'verified', issuer, subject, principalKind, self}`. It never returns a session id (a Clerk sid, or in the hosted gate a presented login token), the stored envelope or its digest. Whether a Clerk sid is itself an authentication token is not claimed; the exposure that matters is the hosted gate's token, and the session is dropped either way. The cursor is the numeric sequence number: it holds no secret, but it reveals position in the whole log (a follow-up).

## D1 semantics assumed, not proven here

The stand-in is SQLite, which D1 is built on. The following are assumptions until the parent's D1 run proves them: triggers with `RAISE(ABORT, …)`, `BEFORE INSERT` triggers firing ahead of `INSERT OR REPLACE` conflict handling (with `recursive_triggers` on or off), `INSERT … SELECT … WHERE NOT EXISTS`, `AUTOINCREMENT` ordering, `CHECK` constraints across columns, `UPDATE`-trigger `WHEN` conditions comparing `NEW` and `OLD`, per-statement atomicity of the insert plus its counter trigger, and that a statement whose response is lost may still have committed (the read-back handles both cases).

## Parent handoffs

1. Add `tests/hosted-foundation/audit/**/*.test.ts` to the root Vitest include. Until then run `bunx vitest run -c tests/hosted-foundation/audit/vitest.config.ts`.
2. Apply `0001_native_audit.sql` to each client's D1 and call `provisionAuditBinding` (from `trusted.ts`) from trusted provisioning only. The migration is still unreleased and was corrected in place; no remote D1 apply has been recorded.
3. Compose per request in `hosted/services.ts`: `requestAuditSink(...)` as `RequestServices.audit`; `publicAuditReader(...)` for the audit view route only; `trustedGrantAuditPort(...)` as GRS-114's `GrantAuditPort`. Never expose `createD1AuditLog`, `find` or a provisioning call to a route.
4. Extend the shared hosted-imports guard so only trusted composition (services wiring, provisioning, the grant service) may import `src/lib/audit/trusted.ts` and `d1-log.ts`.
5. Supply an `AuditReadGate` backed by GRS-114 case grants and administration roles.
6. Rate-limit audit queries per actor or address across requests, and decide retention or archival and the capacity numbers per client.
7. Feature owners instrument their own events with opaque identifiers and `caseId` on case content. Routes or UI for audit views are not built here.

## Follow-up (not done in this round)

- Issuer and principal kind are not bound to each other (an issuer is trusted for both `client` and `staff`); this relies on GRS-113's mapping.
- The administration view excludes case, versioned and case-tagged events but does not allowlist administration object kinds; that needs the producer contract.
- The query cursor is the global sequence number.

## PENDING: control-plane actor

GRS-114's bootstrap uses a synthetic verified actor (`control-plane:<clientId>`). This adapter refuses it: the issuer is not an `https:` trusted issuer. Extending `IdentityState`/`AuditEvent` with a system or control-plane actor, and deciding how it is attributed, is a PENDING coordinator/user decision. There is no fallback.
