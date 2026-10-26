# Concrete D1 atomic publication adapter

`src/lib/publication/hosted/d1-publisher.ts` supplies `d1PublicationPublisher({ db, clientId, checkSession }): StoragePublisher`.
It is a concrete SQL adapter, not a queue, process mutex, ordinary pointer CAS, or hosted acceptance claim.

## Required parent protocol correction

`StoragePublisher.protocol` remains `atomic-publication/1` for the existing controller. Its current comment in
`ports.ts` requires serializing **external session revocation** through commit. D1 cannot provide that guarantee for
Clerk. Before composing this adapter, correct that contract (and the corresponding controller comments) to distinguish:

- **External authorization observation:** the current request's fresh Clerk session/expiry/revocation check resolves
  immediately before submission of the SQL transaction. Any denial observed by this check prevents mutation. A fault
  prevents mutation too. A later Clerk revocation can race the commit; no D1 transaction or local mutex locks Clerk.
- **D1 authorization/publication linearization:** the receipt INSERT's predicates observe current case publication
  grant, expiry by database time, local session-revocation fence, effective sign-off, exact current candidate/link and
  generation, stored results version and expected pointer. These checks and pointer/receipt/baseline/withdrawal writes
  share one D1 transaction. D1 writers ordered before it deny stale authority; writers ordered after it cannot undo the
  historical operation. The session check and D1 commit are two distinct boundaries, not globally atomic.

If the product requires Clerk revocation-before-D1-commit to *always* win, leave composition null (503). That stronger
contract needs a different authority architecture; this adapter deliberately does not simulate it.

## Migration and real dependencies

Apply these sources to the **same client-bound D1**, before enabling routes:

1. Existing GRS-115 `src/lib/storage/cloud/migrations/0001_rs_results_storage.sql`; provision `rs_storage_identity`
   with the deployment's client and `layout = 'clearcase.rs/1'`, plus real `rs_case` rows.
2. Existing GRS-114 `src/lib/tenancy/migrations/{0001_tenant_case_grants,0002_tenant_grant_operations}.sql`.
3. Candidate owner's `src/lib/results-review/native/migrations/0001_native_candidate_import.sql`, including the
   `native_candidate_audit_intent` and `native_candidate_audit_settlement` additions at `ebe3ed4b9449f660767c400ce5a567b38c3e1618`.
   The original candidate/link/supersession schema was inspected at `e22c423b`; its corrected current predicate also
   requires exact durable audit settlement. An older installed candidate schema needs the owner's additive upgrade.
4. `src/lib/publication/hosted/migrations/0001_publication_ledger.sql` at `fbf1c16f` (both audit envelopes and signed
   identity columns), then **new** `src/lib/publication/hosted/migrations/0002_atomic_publication.sql`.
   `CREATE TABLE IF NOT EXISTS` does not upgrade an older ledger; parent supplies an additive upgrade if needed.

New schema: `pub_candidate_generation`, `pub_session_revocation`, immutable `pub_apply_receipt`, and read-only view
`pub_durable_intent`. Migration seeds generations for existing links and permanently invalidates pre-fence sign-offs;
those people must review/sign off again. No historical person/session or successful operation is invented.
Receipt INSERT triggers change `rs_publication`, record `rs_version_withdrawal` on withdrawal, and replace the trusted
warning baseline from the signed warning set on publication. Withdrawn versions cannot be republished through a new
operation; their receipts remain readable. No version, original, preview, user work or immutable evidence is deleted.

## Exact composition and other-owner hooks

- Import **directly** from `src/lib/publication/hosted/d1-publisher.ts`; this task does not edit the shared barrel.
  Pass the raw `env.DB` binding, not a read-replica session. Its `withSession('first-primary')` is required; each receipt
  or generation read starts on the primary, and each mutation uses one guarded primary D1 batch.
- Continue supplying `d1PublicationLedger` and the native candidate repository from that **same raw client DB**.
  Do not mix databases, replica/cache candidate reads or other stores with publication predicates.
- `checkSession(authority)` is required. Close over this request's verified `Identity`; compare its client, principal
  (issuer/subject/kind) and session to the supplied **current retry authority**, reject mismatch, then call its real
  `checkRevocation()`. No JWT-only check or saved boolean. Known session denials map to `guard-refused/invalid-session`;
  unknown faults reject. Existing `mutation.recheck()` still runs first and propagates its controller error unchanged.
- Supply the existing real GRS-114 `authorizeCapability(... capability: 'publish')` as `ports.authorize`; SQL independently
  requires an active, unexpired explicit **case publisher** grant of the retry principal. No staff/admin inference.
- **CandidateReader owner:** use `d1PublicationSnapshotRevision(db, {clientId, caseId, candidateId})` immediately before
  and after assembling the real snapshot from primary, immutable/versioned facts. Reject null or unequal revisions;
  otherwise expose that value as `snapshotRevision`. A synthetic revision or request-provided readiness flag is unsafe.
  The helper also requires candidate audit settlement and absence of supersession.
- Triggers automatically advance the generation and durably invalidate old sign-offs for native supersession and
  INSERT/UPDATE/DELETE (including REPLACE) of package files, documents, assets, seeds, previews, results metadata and
  case original bindings/metadata. Native candidate/link rows retain their owner's immutable triggers. Keep alone
  does not invalidate. Edit writers need no process lock and cannot revive a sign-off by reverting values.
- **Other dependency owners:** if a new D1 table, renderer/readiness state or provider/configuration fact affects a
  candidate snapshot, persist/version that fact and, in its SAME D1 batch, execute
  `UPDATE pub_candidate_generation SET generation = generation + 1 WHERE client_id = ? AND case_id = ? AND candidate_id = ?`.
  Invalidate *before* changing any externally stored dependency; publish only immutable, version-addressed R2 bytes.
  Untracked mutable external readiness cannot be made atomic by a later callback; do not compose it as safe.
- **Identity owner (optional local fence):** positively observed revocations can be recorded with
  `INSERT INTO pub_session_revocation(client_id, issuer, session_id, revoked_at) SELECT ?, ?, ?, ? WHERE NOT EXISTS
  (SELECT 1 FROM pub_session_revocation WHERE client_id = ? AND issuer = ? AND session_id = ?)`.
  Commit before acknowledging local revocation. This deny-only fence supplements, never replaces, fresh Clerk checks.
- Install through existing `setPublicationComposition`; retain the existing candidate, ledger, authorizer, clock and
  parent-owned audit ports. Retire any separate pointer writer; never wrap the old CAS or add a process queue.
- **Audit owner:** supply trusted, eventId-idempotent historical-operation delivery of the exact persisted
  `receipt.intent.auditEvent` / ledger envelope. An ordinary later request sink may reject its old session; this module
  does not fabricate a past verified requester, system person or generic audit factory. Parent recovery may enumerate
  `pub_apply_receipt JOIN pub_operation USING(operation_id)` where operation state is pending/failed/applied and settle
  through the existing ledger APIs only after the trusted sink confirms delivery. No receipt recovery changes pointers.

## Light checks and limits

Run with Bun 1.4.2 through `scripts/agent-tools/receipt`:

- `bun run --bun test --config tests/publication/hosted/atomic-d1/vitest.config.ts`
- `bun node_modules/typescript/bin/tsc --noEmit -p tests/publication/hosted/atomic-d1/tsconfig.json`

The tests execute the production adapter, triggers and real table schemas on temporary file-backed SQLite with two
connections. Candidate schema fixture is byte-identical to the candidate owner's corrected migration (Git blob
`2124dca1a8b3e48bc6c1e03bdfcfe1ced8b708a2`). Its D1-shaped transport injects races, rollback, readback and acknowledgement
failures; the real controller/ledger recovery is also exercised. This is SQLite/component evidence, **not real D1 proof**.
Parent owns native D1/workerd validation, provider integration, bundle/build/gates and deployment. Add this test subtree
to the parent discovery configuration when integrating; do not run a full suite as a substitute for native proof.
