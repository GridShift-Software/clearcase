# Committed historical audit delivery

`src/lib/audit/recovery.ts` adds a trusted delivery boundary, not a publication or authorization boundary.
There is **no deployed proof**. The local checks exercise synthetic SQL/component behavior only.
Real Cloudflare D1, Clerk, providers, browser, workerd, build and full-suite acceptance remain unrun here.

## API and composition

```ts
committedAuditRecovery({ db, config, now }): CommittedAuditRecovery
// .candidate: CandidateAuditRecovery
//   appendCommitted({ clientId, caseId, candidateId, event }): Promise<{ eventId }>
// .publication: Readonly<AuditSink>
//   append(event): Promise<{ eventId }>
```

Import directly from `src/lib/audit/recovery.ts` **only in the parent's
`src/lib/server/runtime/hosted/services.ts`**. No barrel, facade, route, controller or migration changes are included.
The existing hosted source-graph guard already restricts every `src/lib/audit/*` constructor to that composer,
checks each edge before its visited cache, and forbids even that composer from directly importing `d1-log.ts`.
The internal `committedDeliveryCore(args, load)` is audit-internal and is not re-exported from any barrel.
Its mandatory loader must prove provenance; only the two fixed SQL-backed loaders above are composed here.
Never hand a raw core, loader, DB, recovery constructor or candidate recovery port to a route.
The publication sink may supply the publication controller's audit port: it accepts only persisted publication facts.
It is not a replacement for the general public request audit sink.

Pass the **same raw client D1** used for native candidates, publication ledger/receipts, results storage and audit.
`db.withSession('first-primary')` is required; every append starts a fresh primary session for source reads and audit
write/readback. `rs_storage_identity` must match `config.clientId` with layout `clearcase.rs/1`, and the existing audit
core independently requires its immutable `native_audit_binding` to match. Neither binding is provisioned by recovery.
Use the validated trusted `AuditConfig`; `now` does not replace the original event's time or actor.

## Immutable sources and exactness

- **Candidate:** `native_candidate_audit_intent.event_id/event_json/event_sha256`, loaded through the real
  `d1NativeCandidateRepository.auditIntent`. Its readback verifies canonical JSON/digest and the immutable
  `native_candidate` / `native_import_link` identity and link digest, then `verifyCandidateAudit` checks the exact
  import/correction action, candidate, case, resultsVersion, original operator/session, link time and derived event id.
  Caller-provided client/case/candidate/event values are lookup hints, never proof. A foreign or missing source refuses.
- **Sign-off:** `pub_signoff.audit_event`, scoped by configured client, case and signoff id; its immutable signer
  issuer/subject/kind, signed_at, results_version and `so-<operation_id>` must reproduce the whole event, including the
  session-derived event id. The source's candidate/link/submission/package/preparer fields must match the original
  immutable native candidate/link rows. Its state or currentness is not substituted for those bytes.
- **Publish/withdraw:** `pub_operation.audit_event` plus a **real immutable `pub_apply_receipt`** with matching
  client/case/operation. The entire parsed canonical `receipt.intent_json` must equal `pub_durable_intent.intent_json`,
  including request digest, expected pointer, actor, signed identity, event and time. Operation columns must reproduce
  the original event exactly. Pending/failed outcomes with a receipt are committed facts; an applied label, a refused
  operation, a pending intent without a receipt, or today's matching publication pointer cannot prove application.
  The receipt's retry-authority session never replaces the original event session.

Native sources are canonical event JSON; publication sources retain JSON written by the ledger, so key order is
normalized for comparison. Duplicate-key source JSON is refused. Both caller and authoritative event pass the unchanged
request-event envelope validator, and their **complete canonical envelope bytes** must match before append.
Unknown fields, arbitrary actions, altered ids/actor/session/time/content, anonymous/system actors and untrusted issuers
fail closed. Successful acknowledgement comes only from the existing audit core's exact canonical/digest readback.
An existing id with different bytes conflicts. Lost write acknowledgement succeeds only if that exact row is readable;
missing/readback-failed writes and exhausted protected-event capacity leave settlement pending. Exact replay succeeds
without another row even at the capacity bound.

A historical person is **not** reconstructed as a currently verified requester. No system person is invented and public
requester matching is unchanged. Revoked sessions/grants and later candidate supersession/sign-off invalidation do not
erase a previously committed fact; delivery records that original fact without authorizing new activity, clearing
invalidation, applying a receipt, changing pointers/baselines, settling records, or granting access.

## Required parent scheduler and settlement hooks

The parent services owner supplies independent scheduled/queue recovery, not just uploader/publisher retries.
Use bounded pages and retry/backoff after faults; keep progress per client/case and do not starve later cases.

1. Enumerate actual cases in the configured client DB. For candidate intents invoke existing
   `recoverNativeCandidateAudits({ clientId, caseId, repository, recovery: ports.candidate, limit })`, with limit 1..100.
   That hook loads pending intents independently, checks acknowledgement eventId, then calls `repository.settleAudit`.
   Delivery alone never marks a candidate current. An interrupted settlement safely replays the same envelope.
2. Independently page `pub_signoff` where `client_id = ? AND state = 'recorded'`. Load its persisted `auditEvent`, append
   through `ports.publication`, check the acknowledged id, then `ledger.settleSignoff`. Preserve invalidation: delivering
   an invalidated sign-off must never make it effective or publish it. No new candidate review is fabricated.
3. Independently page `pub_operation JOIN pub_apply_receipt` on **client/case/operation**, where configured client matches
   and operation state is pending/failed/applied. Load the durable operation and exact receipt, compare their intents,
   append its retained `auditEvent`, and check acknowledgement eventId. Only then reconcile pending/failed to applied
   with `ledger.finishOperation({ ...key, state: 'applied', reason: null })` and call `ledger.settleOperation(key)`.
   Never call `publisher.publish/withdraw`, infer a receipt from the pointer, or create a fresh event on this path.

If append or settlement fails, leave the record eligible for the next independent pass. Existing sign-off invalidation,
current-session checks and atomic publication predicates remain the only authority for new publication operations.
Parent also owns root test discovery, integrated build/validation and real provider acceptance.

## Local checks

Run through `scripts/agent-tools/receipt` with explicit file inputs:

- `bun run --bun test --config tests/hosted-foundation/audit-recovery/vitest.config.ts`
  runs the new recovery/source-barrier tests and all existing audit protection tests unchanged.
- `bun node_modules/typescript/bin/tsc --noEmit -p tests/hosted-foundation/audit-recovery/tsconfig.json`
- `bun run --bun check:hosted-imports`

The new transport executes actual production SQL migrations on temporary file-backed SQLite, with production candidate
repository, publication ledger, atomic D1 publisher and audit core. Synthetic grants/session checks are fixture setup,
not a claim about Clerk. Tests cover forgery/foreign scopes/noncommitted sources, retained original envelopes across
revocation/new sessions/restart, supersession/withdrawal, exact replay/conflict, SQL immutability, capacity and lost
write/readback acknowledgements. Source-barrier fixtures exercise the real edge checker in both hosted profiles.
