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
- A sign-off names the exact identity the human reviewed: candidate, link, submission revision and manifest SHA-256, resultsVersion, package `manifestSha256`, package inputRevision, `diagnosticsSha256`, validator version and snapshot revision. Any difference from the current candidate gives 409 `stale-candidate`.
- Sign-off is refused for a rejected import or any error (never waivable), any required section that is not `valid`, and any required preview that is not `rendered`. The candidate reader supplies facts only. A snapshot with any undocumented key, such as `ready`, is unreadable (503). A request with one is invalid (422).
- Acknowledgements cover exactly the new warnings (warnings minus the case's trusted baseline), each once, each with a non-empty reason. Missing, extra, duplicated or error fingerprints are refused.
- The preparer can approve their own candidate only with `selfApproval: true`, recorded on the sign-off. Anyone else claiming self-approval is refused.
- A sign-off is effective only once its audit event persisted (`recorded` → `audited`). Retrying the same operation settles it.
- Publish re-reads the candidate. A changed identity, a newly failed check or a changed new-warning set invalidates the sign-off permanently and refuses the publish (409 `signoff-stale`). Publication is a compare-and-set through the injected storage publisher on the expected pointer state. A conflict (409) or a fault (503) changes nothing, so the previous publication and all user work stay. A retry of an applied operation only finishes its audit.
- Withdrawal requires the same explicit authority and a CAS on the expected published version. It calls only the publisher's `withdraw`. There is no delete, no rollback by deletion and no user-work or originals call.
- The ledger's triggers refuse every rewrite of bound fields, every delete and every `REPLACE`. The only changes allowed are `recorded` → `audited`, a single invalidation, and the recorded operation transitions.

## Parent handoff (integration, not done here)

1. Compose `NativePublicationPorts` with `setPublicationComposition`: `authorize` adapted from GRS-114 `authorizeCapability` (`publish`); `candidates`, a real private-candidate reader joining the immutable import link, stored validation, the trusted baseline and section and preview states; `publisher`, a GRS-115 adapter over `rs_publication` / `rs_version_withdrawal` with an atomic guarded CAS; `ledger: d1PublicationLedger(env.DB)`; `audit`, the request audit sink.
2. Apply `0001_publication_ledger.sql` through the parent's migration list and Wrangler configuration.
3. Add `tests/publication/hosted/**/*.test.ts` to the root Vitest include, or keep the directory config.
4. Run the full check, suite, gate, workerd and browser runs. All of them are UNRUN here.

## Open questions

- ADR-0010 names review authority. GRS-114 has only `operate` and `publish`, so sign-off and publication both require `publish`. A distinct review capability needs a policy decision.
- The audit event is appended after the pointer applies, and a failed append returns 503 until a retry settles it. Real audit durability is unverified.
- The storage publisher contract (CAS semantics, no deletion) is typed but not implemented against GRS-115.
