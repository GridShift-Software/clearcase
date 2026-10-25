# Native exact-version sign-off and publication (prepared, unverified)

**Status: PREPARED / UNVERIFIED.** Component code and unit tests over doubles only. No real D1, GRS-114 grants, GRS-115 storage, audit log, workerd, browser or deployment has run it. Nothing here is a hosted, gate or native PASS, and a test that approves its own synthetic candidate is not acceptance.

Implements the [ADR-0010](../adr/0010-exact-version-signoff-and-publication.md) rules for the native alpha against the [import-link contract](../hosted-foundation/native-integration-contracts.md) and the [acknowledgement contract](../results-package.md#known-baseline-acknowledgement-and-activation).

## Surface

- `src/lib/publication/hosted/`: `ports.ts` (typed parent ports), `rules.ts` (pure sign-off rules), `ledger.ts` (D1 adapter), `controller.ts` (`createNativePublication`), `composition.ts` (`setPublicationComposition`), `migrations/0001_publication_ledger.sql` (`pub_*`).
- Routes, POST only, under `deploy/client/routes/operator/publication/[caseId]/`: `signoffs`, `publish`, `withdraw`.
- Tests: `tests/publication/hosted/` with their own Vitest config (its include list replaces the root list) and tsconfig.

## Rules enforced

- Every route checks, in this order: same-origin POST, `application/json`, all ports composed (else 503 `publication-unavailable`), case id, verified session of this deployment's client (401), `checkRevocation()` (401), then explicit case `publish` authority from the injected authorizer (uniform 403). Only after that is the bounded body (64 KiB) or any ledger, candidate or pointer state read.
- No authority is inferred from staff, global-admin or client identity. No role, review capability or default is invented.
- A sign-off names the exact identity the human reviewed: candidate, link, submission revision and manifest SHA-256, resultsVersion, package `manifestSha256`, package inputRevision, `diagnosticsSha256`, validator version and snapshot revision. The diagnostics digest accepts the canonical validator's exact `sha256:<64 lowercase hex>` form and legacy bare 64 lowercase hex; identity comparisons remain exact-byte comparisons, so the two forms are not interchangeable. Any difference from the current candidate gives 409 `stale-candidate`.
- Sign-off is refused for a rejected import or any error (never waivable), any required section that is not `valid`, and any required preview that is not `rendered`. The candidate reader supplies facts only. A snapshot with any undocumented key, such as `ready`, is unreadable (503). A request with one is invalid (422).
- Acknowledgements cover exactly the new warnings (warnings minus the case's trusted baseline), each once, each with a non-empty reason. Missing, extra, duplicated or error fingerprints are refused.
- The preparer can approve their own candidate only with `selfApproval: true`, recorded on the sign-off. Anyone else claiming self-approval is refused.
- A sign-off is effective only once its audit event persisted (`recorded` → `audited`). Retrying the same operation settles it. Its original audit envelope is persisted and reused even from a different session.
- Publish checks the candidate for early feedback, then requires the atomic adapter to run fresh session/grant and effective sign-off/candidate checks inside the shared mutation boundary. A changed identity, a newly failed check or a changed new-warning set invalidates the sign-off permanently and refuses the publish (409); a revoked grant returns 403 and a revoked session 401. A stale saved boolean or an ordinary CAS after an unguarded pre-read cannot implement this contract.
- Before mutation, the write-once operation intent pins the exact signed identity, expected pointer, actor and original audit envelope. The adapter atomically stores an operation-bound apply receipt with the pointer CAS. Recovery reconciles that receipt **before** rejudging a pending/failed operation's candidate. Later edits, invalidation or another publication cannot strand the original audit or cause reapplication. Current pointer equality is never proof that this operation applied. An unconfirmed commit returns 503 without claiming that nothing changed.
- Withdrawal requires the same fresh mutation-boundary authority and a CAS on the expected published version. It uses the same receipt/recovery protocol and calls only the publisher's `withdraw`. There is no delete, no rollback by deletion and no user-work or originals call.
- The ledger's triggers refuse every rewrite of bound fields, every delete and every `REPLACE`. The only changes allowed are `recorded` → `audited`, a single invalidation, and the recorded operation transitions.

## Parent handoff (integration, not done here)

1. Compose `NativePublicationPorts` with `setPublicationComposition`: `authorize` adapted from GRS-114 `authorizeCapability` (`publish`); `candidates`, a real private-candidate reader joining the immutable import link, stored validation, the trusted baseline and section and preview states; `ledger: d1PublicationLedger(env.DB)`; `audit`, a sink idempotent by eventId. Audit retries reuse the stored envelope, not the retry session.
2. Supply the **required new** `StoragePublisher` contract: `protocol: 'atomic-publication/1'`, `receipt({clientId, caseId, operationId})`, and `publish` / `withdraw({intent: PublicationIntent, authority: {clientId, caseId, principal, sessionId, capability: 'publish'}, recheck(): Promise<void>})`. A legacy publisher fails closed with 503. Guard the current request's `authority`, not the original audit session. Each mutation must verify the saved intent, serialize with all candidate/link/dependency edits, sign-off invalidations and session/grant revocations, run `recheck` there, then CAS the expected pointer and atomically write `{intent}` as a durable, write-once receipt. The same serialization must cover every participating writer through commit; a JavaScript precheck followed by a D1 CAS is insufficient. Propagate callback errors unchanged; atomic predicate failures return `{kind: 'guard-refused', reason: 'forbidden' | 'invalid-session' | 'signoff-stale'}` (403/401/409), not a generic storage refusal. Edit writers must durably invalidate old sign-offs. Preserve receipts across restart and subsequent publications/withdrawals. If this cross-boundary protocol is unavailable, leave the composition null.
3. Apply the amended, **unreleased** `0001_publication_ledger.sql` through the parent's migration list and Wrangler configuration. New immutable fields: `pub_signoff.audit_event`, `pub_operation.signed_identity` and `pub_operation.audit_event`. Existing scratch databases with the old schema are not upgraded by `CREATE TABLE IF NOT EXISTS`; parent must migrate them before wiring, without deleting ledger evidence.
4. Add `tests/publication/hosted/**/*.test.ts` to the root Vitest include, or keep the directory config. The original 37 assertions/tests remain unchanged; the three protected reviewer probes and additional lifecycle/concurrency regressions are additive.
5. Run the full check, suite, gate, workerd and browser runs. All of them are UNRUN here.

## Remaining integration boundaries

- Alpha policy explicitly uses the case `publish` grant for sign-off and publication; no separate review-role decision blocks this component.
- The audit event is appended after the pointer applies, and a failed append returns 503 until a retry settles it from its receipt and stored envelope. Real audit durability and eventId deduplication are unverified.
- The required atomic adapter and durable apply-receipt store are typed but not implemented against GRS-114/115. The test-only publisher models serialization and receipts in memory; that is not durable or provider evidence.
