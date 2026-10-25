# Native candidate stager

Local synthetic adapter evidence only. This is not deployed, workerd, provider, browser or live-alpha evidence.

## Parent composition

`src/lib/server/runtime/hosted/candidate-stager.ts` exports:

```ts
createHostedCandidateStager({
  bindings: { db: primaryDB, bucket: privateBucket },
  clientId, budgets, quotas, identity, authorizeOperate, audit, now,
}): { stager: CandidateStager; packages: StoredPackageReader }
```

Every argument is required, from trusted deployment/request composition, not request JSON. There are no budget or quota defaults. Malformed/inconsistent policy throws retryable `storage-unavailable`; the parent leaves native ports unconfigured until policy exists. Budgets/quotas are parsed, copied and frozen. Bindings must be the deployment's primary D1 and private R2, not recovery/read replicas. The canonical storage identity gate proves both name this deployment's client.

Parent-only work (not wired by this change):

- Compose these two ports into the native import service in the request services/compositions; retain its request/body limits. Match those limits to storage budgets rather than silently enlarging either.
- Supply the authenticated request `Identity`, real current case-scoped `operate` authorizer and request-bound durable `AuditSink`. Staff kind alone is never authority; the authorizer must uniformly deny unknown/ungranted cases and check the supplied principal/session/client/case. A false runtime return also denies.
- Install all `storage/cloud`, `submissions`, and `results-review/native` migrations, including the verification work ledger. The factory constructs the real D1 submission and native candidate repositories itself; there is no injected snapshot, currentness boolean, validator or success-stager hook.
- Keep native link/audit settlement, supersession, recovery and publication with their existing owners. A privately stored version without a durably audited current native link is not readable for correction. This factory grants nothing, signs off nothing and never writes publication.
- Register the private tests and include this entry in the combined hosted graph/artifact/native checks. No shared guard, services or composition file changed here. Mid-call identity/session failures remain thrown contract errors; HTTP handling belongs to the parent.

## Authority, selection and validation

Before protected metadata or bytes, require verified **staff**, exact deployment/request client, current session and explicit operate permission for the exact case. Scoped D1 operations and R2 get/head/put/body operations reauthorize on both sides of each await. Audit and final release are followed by another current-authority check. Caller IDs, submission snapshot and bounded package buffers are pinned before the first await; package/case/identity checks precede original metadata reads.

The exact selected submission is re-read through `submissionSnapshotReader(d1SubmissionRepository(primaryDB))`, including finalized upload state, all manifest fields, persisted canonical manifest digest and byte count. The whole caller snapshot must match, before staging, after staging and after the final audit. Neither sequence nor package inputRevision chooses a submission. The package inputRevision/resultsVersion/manifest bytes remain unchanged.

Select by **indexed package path first**, within that submission revision's real finalized `caseFolder` records. Prefer literal paths; otherwise require one actual case/NFC-folded path. Only then compare exact sha256 and size and the snapshot's asset/path association. Missing, ambiguous, foreign, changed or unassociated originals refuse; a globally present hash never establishes lineage. An older explicit revision can be selected even if a newer revision occupies the path. Canonical `readOriginalFacts` independently checks links against the entire real case folder, D1 finalized associations, content keys and full R2 bytes; conflicting literal/folded folder states can conservatively refuse rather than choose another revision.

A bootstrap full-byte check of the selected real originals supplies positive facts to genuine `validateHostedPackage`. This obtains canonical ORIG_CASE_MISMATCH fingerprints **before** constructing typed `RequiredOriginalLink`s; none are synthesized. `buildCoverage` retains every package alias and the exact required submission file set. `readOriginalFacts` then independently proves those links; genuine validation runs again over its facts and must agree. Missing file facts refuse even if the canonical validator would otherwise permit a missing-original warning. Declared missing/embedded assets remain canonical unavailable entries, not invented mappings.

Errors reject. Accepted/report candidates use the canonical hosted projector and real `createResultsStaging` with exact captured files, identity, genuine validation and original links. Storage independently derives and compares the model. Its canonical overview stores package-level diagnostic counts (the existing projector contract); the separate validation fields store the complete genuine validator identity.

## Finite work and readback

One atomic `admitVerification` reservation precedes all deep original/package reads. For `U` distinct selected original hashes, `B` unique original bytes, `F` package files and `P` package bytes, reserve:

- **objects = 4 × U + F; bytes = 4 × B + P**.
- Passes: bootstrap verified bytes; independent `readOriginalFacts`; ResultsStaging's independent original verification; post-storage `readOriginalFacts`. The last pass catches changes during persistence. Each pass deduplicates package aliases by original hash.
- The `F/P` portion pays for exact persisted package readback. Readback does not call the published reader or `verifyVersion` and does not reserve another deep window.
- Repeats conservatively reserve the same upper bound, although ResultsStaging's immutable-repeat shortcut skips its original pass. Work remains spent on refusal/failure and is never refunded or reset. Each factory scope/storage gate separately reads at most the canonical 1 KiB identity object; these bounded metadata reads are not deep-verification objects.
- Per-original buffering/original size, package file/count/total, document counts, per-call and atomic case-window limits all apply. Case-folder metadata is additionally checked against the explicit upload quota. Repository metadata uses the existing quota-bounded intake schema; no new metadata cache or latest-revision heuristic is introduced.

Stored readback bounds file rows/bytes, checks exact content keys, reads full R2 bytes with `verifiedRead`, verifies exact package identity/case/input revision and compares captured bytes. It checks the stored model's counts/digest and its digest against the freshly derived canonical model. Post-storage original facts and genuine diagnostics must still agree. Persisted verdict, validator version, diagnostics digest and complete warnings must exactly match fresh validation, **including on repeated storage success**. Changed diagnostics refuse without mutating the immutable version. Only then return `staged` with persisted validation fields and the uncapped genuine mismatch mapping (tested beyond 2,000 listed diagnostics).

Canonical staging refusals retain their reason/detail. Backend storage faults stay retryable `storage-unavailable`; exhausted verification windows throw retryable `busy`, not a validator rejection. Per-call over-budget refuses before deep reads. Audit failure never yields success, though an immutable private storage write may already have completed; retry rechecks that storage rather than claiming an unverified prior success.

## Private correction bytes

`packages.files` uses current staff/operate authority, not published-client visibility. It requires the real native repository's durably audited, non-superseded current candidate and exact linked manifest. It reserves its **own** package-only `F/P` work plan, bounds and verifies every stored byte/content key, package case/input identity and stored-model integrity, audits before release, then rechecks currentness and authority after the audit. No raw unbounded bucket read or cached currentness is used. Subsequent correction staging re-verifies originals; reading correction package bytes is not a claim about present original availability.

## Focused checks

```sh
scripts/agent-tools/receipt --name native-stager-tests -- bun run --bun vitest run --config tests/hosted-foundation/native-stager/vitest.config.ts --maxWorkers=1
scripts/agent-tools/receipt --name native-stager-types -- bun run --bun node_modules/typescript/bin/tsc --noEmit -p tests/hosted-foundation/native-stager/tsconfig.json
```

The private include runs synthetic packages through real schemas, SQLite-backed D1/R2 stand-ins, intake, canonical validator, original facts, staging, native repositories and a full authored reviewer correction. It includes foreign/missing/changed originals, competing revisions, aliases, case/NFC ambiguity, retry diagnostic/model/object corruption, interrupted storage, finite work/size/quota failures, pre/post-await authority and audited reader currentness failures. The source-closure probe permits only existing canonical `node:crypto` (the parent's nodejs_compat decision), `typebox` and `typebox/value`; it forbids filesystem/local-case/SDK/network/processing/other host-module dependencies. Stand-ins and source checks are not provider or deployed-artifact proof.

Unrun here: full build/suite/gates, browser, workerd, native/provider evidence and deployment. Fresh independent review and combined-head integration remain with the parent.
