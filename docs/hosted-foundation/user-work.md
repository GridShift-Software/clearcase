# Hosted case user work over D1 (GRS-117, prepared)

Status: **PREPARED, UNVERIFIED.** The unit tests in `tests/hosted-foundation/user-work/` run the adapter over a `node:sqlite` stand-in for D1 with the real migration, plus in-process doubles of the `Identity`, `AuditSink` and `CaseReader` ports. One test uses the GRS-116 `requestAuditSink` over the same stand-in. None of this is evidence of Cloudflare D1, workerd, Clerk or a deployed client. Nothing is composed into `hosted/services.ts`, so production still answers 503 for user work. Words follow [GLOSSARY.md](../../GLOSSARY.md).

## Modules

| Module | Exports |
| --- | --- |
| `src/lib/user-work/hosted/migrations/0001_uw_user_work.sql` | The `uw_*` tables and triggers. Applied by the deployment, never by the Worker. Unreleased, so it may still be corrected in place. |
| `src/lib/user-work/hosted/index.ts` | `createD1UserWork(options): AsyncUserWork`, `d1WorkRevision({ db, config })`, `userWorkConfig(value)`, `USER_WORK_SCHEMA_VERSION` (1), `USER_WORK_FORMAT`, `USER_WORK_CEILINGS` and the types `D1UserWorkOptions`, `D1UserWorkConfig`, `D1UserWorkLimits`, `UserWorkDefinitionAuthority`, `UserWorkFailure`, `WorkOutcome`. |
| `src/lib/user-work/hosted/provision.ts` | `provisionD1UserWork({ db, clientId, now })`. Trusted provisioning only, not exported from the barrel. |
| `src/lib/user-work/hosted/validate.ts` | Internal validation. It restates the memory double's rules, because no production module may import the double. |

`createD1UserWork({ db, config, identity, tableDefinitions, audit, store, now })` takes the following:

- `db`: the client's own D1 binding, or null. With null, every call refuses with `storage-unavailable`.
- `config`: `{ clientId, limits: { maxStatementsPerBatch, maxSnapshotBytes } }`, from trusted deployment configuration. Every value is required, there are no defaults, and each value has a hard ceiling (`USER_WORK_CEILINGS`, 1000 and 2,000,000). The ceilings are conservative bounds the parent narrows. They are not measured D1 limits.
- `identity`, `audit`, `store`: the request's own services. No actor factory is imported. The audit actor is built from `identity`.
- `tableDefinitions?: UserWorkDefinitionAuthority | null`: a trusted parent authority for client-global definition registration. Omitted/null denies it. Its exact hook is `authorize({ clientId: ClientId, actor: IdentityState, definition: UserWorkTable }): Promise<void>`; resolve only for an explicit current administrative/provisioning grant or an exact trusted feature-definition catalogue entry, otherwise throw `contractError('forbidden')`. The normalized definition includes name, owner, description, scope, kind, columns and primary-key positions. The parent must not implement this by accepting any signed-in member, a staff principal, a role label or a case grant. The hook may be called repeatedly and must check current authority each time. The adapter also rechecks the request session after awaiting it.

A missing identity, sink, reader or clock is a `TypeError` at construction.

## Rules

- **Client and schema.** `uw_binding` must name `config.clientId` and schema version 1. Otherwise every read and write refuses with `storage-unavailable`. An identity whose `clientId` is not the configured one gets `wrong-client` before storage is touched. A request never binds or upgrades a database. Only `provisionD1UserWork` binds an empty database, once, and it refuses another client or version. Triggers fix the client and forbid deleting the binding or lowering its version. A later schema needs a new migration and an explicit version change; the adapter refuses any version it does not know.
- **Authorization on every operation.** Each read calls `identity.checkRevocation()` and then `identity.authorize({ caseId, operation: 'read' })`. Each write does the same with `'write-user-work'`. A same-operation replay is authorized again before acknowledging its stored event and before releasing its result. `tables` checks client standing. `defineTable` requires a verified, current session and `tableDefinitions` authority, rechecked before registration and release. Missing definitions in `importAll` require the same explicit authority before the guarded batch; restoring rows of already registered tables needs only the current case write grant. One public boundary appends each authority refusal's scoped `denied` event exactly once, including early cross-client/cross-case and nested-helper refusals. This is best effort and a failed sink never changes the refusal.
- **Guarded writes.** Each write reads the case revision (`uw_case`, initially `revision-0`) and the rows it affects. It then commits one D1 batch:
  1. A guard that fails unless the revision and the binding are unchanged (`uw_batch_guard` NOT NULL).
  2. The `uw_operation` ledger row: the request digest, the result and the audit event.
  3. The new revision.
  4. The data statements.

  Expected-version checks are made against that read, so a competing writer is never overwritten. A writer of another row is retried against the new revision, up to 8 attempts. A write with an `expectedRevision` (`putTableRows`, `registers.apply`, `importAll`) is `stale` instead.
- **Idempotency.** The ledger is keyed by case and `operationId`. The request digest covers the operation kind, case, payload and principal (issuer, subject, kind). A replay returns the stored result before consulting mutable results context or current row state. Document and analysis Notes still validate visibility/content for fresh operations; seed removal still checks the exact publication for fresh operations. Register replacement hashes the caller's stable store, row id, fields and expected version, and preserves the anchor only inside its fresh-write plan. A replay never recreates a subsequently deleted row. The recorded audit actor retains the original session; a new current session of the same principal can acknowledge that identical event. A reused id with another payload or another principal is `invalid`. `stale` and `gone` are not recorded, as in the memory double.
- **Audit before success.** The caller sees `written` only after the injected `AuditSink` acknowledges the operation's recorded event. The event id is derived from client, case and operation, so a retry appends the identical event. If the event is not acknowledged, the write stays durable and the call rejects with `audit-unavailable` and `outcome: 'written-unaudited'`, keeping the sink's retryability. Retrying the same `operationId` appends the event and then returns the result. Snapshots and table definitions record their events in the same way.
- **Truthful failure states.** A failed batch is decided from durable state: the ledger row and the revision are read back.
  - A committed batch whose response was lost continues to the audit step.
  - No ledger row and an unchanged revision gives `storage-unavailable`, `outcome: 'not-written'`.
  - A constraint failure on a key another case holds gives `restore-key-collision`.
  - A failed read-back gives `storage-unavailable`, `outcome: 'unknown'`.

  Every one of these is retryable under the same `operationId`.
- **Categories.** Case Notes with `case`, `document` and `analysis` targets, seed overlays, register rows, register commands, seed removal, and feature-defined tables (definitions are data, not DDL). None needs a published results version. A fresh seed removal is the one exception: it requires the case's exact published version, as in the memory double. A durable removal can still be acknowledged after withdrawal.
- **Anchors.** A document anchor keeps the results version, the ref at creation and the original's SHA-256.
  - `resolve` keeps the ref only within the same version. In any other version the content digest decides: `exact`, `ambiguous`, `missing`, or `unanchored` when there is no digest. A reused ref never takes a note over.
  - `addNote` refuses an anchor whose digest is not that ref's content in that version.
  - Withdrawing results keeps Notes and rows readable and writable at case level. `summary({ resultsVersion: null })` reports document notes as unanchored and detached, and deletes or hides nothing.
- **Export, snapshot, restore.**
  - `exportAll` reads one revision. It retries if the case changed during the read.
  - `snapshots.put` requires the snapshot to equal the current export (ignoring `exportedAt`) at the given revision. The insert is guarded on that revision and audited.
  - `importAll` requires a pre-restore snapshot of the same case at the replaced revision, with its event acknowledged. It replaces the case's rows of every category in one guarded batch and defines missing tables from the snapshot only through the injected definition authority. A denied definition leaves all case data, definitions and the revision unchanged.
  - A restore larger than `maxStatementsPerBatch` is refused whole. Snapshots, operations and definitions are append-only by trigger, and nothing deletes them.

## Differences from the memory double

- The memory double holds the audit append and the commit in one synchronous step, so an audit failure leaves no write. D1 cannot commit with an external sink atomically. Here an unacknowledged write is durable and visible to readers before the caller sees success, and it is recovered by retry. For a restore, the prior work stays in the pre-restore snapshot.
- Rows are ordered by D1 `rowid` (insertion order), which matches the double's Map order.
- The built-in encoding's description reads "Hosted user-work encoding". An export from the memory double therefore fails the table-metadata comparison here (`table-conflict`), and so does a local SQLite backup. Neither is a migration format.

## Not done here (parent handoffs)

1. Add `tests/hosted-foundation/user-work/**/*.test.ts` to the root Vitest include. Until then run `bunx vitest run -c tests/hosted-foundation/user-work/vitest.config.ts`, whose include list replaces the root list.
2. Apply `0001_uw_user_work.sql` to each client's D1 and call `provisionD1UserWork` from trusted provisioning only. Restrict importers of `provision.ts` in the hosted-imports guard.
3. In `hosted/services.ts`, compose `createD1UserWork` per request as `RequestServices.userWork`, with that request's identity, audit sink (GRS-116 `requestAuditSink`), case reader and explicit `tableDefinitions` hook described above. Pass `d1WorkRevision(...)` as `createCloudResults({ stateRevision })`, so `CaseReader.stateRevision` is the user-work revision that `expectedRevision` callers use. The reader authorizes that read.
4. An audit event that is acknowledged together with the write needs the sink's insert inside the same D1 batch, as a transactional outbox. That changes the `AuditSink` port and is not done. Until then, reconciling writes left unaudited (`uw_operation.audited_at IS NULL`) is an operator task.
5. Supply the trusted definition-authority implementation or an exact feature catalogue when composing the parent. No such authority is inferred or provisioned by this module; without it, new client-global definitions fail closed. Ordinary case-local work remains governed by case grants.
6. Not exercised: D1 batch atomicity, batch and statement-size limits, rowid ordering, triggers, error text (`constraint` and `NOT NULL` matching), latency, workerd and Clerk. Also not exercised: a real `CaseReader` from `createCloudResults`, the hosted routes and feature caller migration. Contextual Notes UI and local-case files are owned elsewhere.
