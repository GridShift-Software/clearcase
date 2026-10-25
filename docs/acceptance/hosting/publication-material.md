# Publication material reader

Status: component implementation; native acceptance **UNRUN**. This does not compose services, authorize publication,
write sign-offs, change a pointer, generate previews, or claim Clerk/D1/R2/workerd/browser acceptance.

## API

Import directly from `src/lib/server/runtime/hosted/publication-material.ts`:

```ts
createPublicationMaterialReader({
  db, bucket, clientId, identity, audit, storageBudgets, validationLimits, renderChecker, now,
}): CandidateReader | null
```

`PublicationMaterialOptions` is exported. `db` is the raw `PublicationD1Database` (the same client DB as native import
and the atomic publisher); the factory obtains `first-primary` sessions. `bucket` is the matching `CloudR2`. `identity`
and `audit` belong to this request. All `StorageBudgets` and all canonical `Limits` are explicit deployment configuration,
with no budget defaults. Pass the same validation limits as the importer. Malformed/missing configuration returns null.
The optional-in-behaviour, required-in-signature `renderChecker` is the typed internal `NativePreviewRenderChecker` or
null. The parent must supply its genuine source-owned native implementation, never deserialize one from a request.

The returned `CandidateReader.read({clientId, caseId, candidateId})` returns a frozen `CandidateSnapshot`, null for an
absent/noncurrent candidate, or rejects without material. No bytes, diagnostics, baseline, or preview state are request
claims. A current verified **staff** session and explicit `read-preview` authority are required before protected reads,
before checker calls, and at release. `operate` is deliberately not required; the reviewer can differ from the preparer.

## Material and integrity

- Actual `d1PublicationSnapshotRevision` observations enclose package/fact/model/SSR/checker/audit awaits. The actual native
  repository verifies immutable candidate/link pins, link digest, exact audit envelope and settlement; supersession holds.
- The storage gate binds both D1 and R2 to the deployment client. Package rows are bounded, content-addressed and read
  with `verifiedRead`; the canonical byte inspector recomputes case/results/manifest/input identities. The current
  `CaseReader` rejects private versions, so this reader uses these gate-protected private reads, not an operate-only
  correction reader or a published-reader bypass.
- One complete verification plan is reserved with `admitVerification` before protected R2 bytes: all package files,
  distinct originals for facts, and another verified original read for each package file ref. Per-object buffering,
  total per-call work and shared per-case-window work are bounded. Model/folder counts are bounded before helper loads.
- `readOriginalFacts` verifies finalized case-original ownership, exact immutable original links, path/fingerprint and
  full bytes. `validateHostedPackage` is the reviewed canonical validator adapter. Its complete error/warning sets and
  every available persisted validation field must agree exactly: verdict, validator version, diagnostics digest and
  complete warning set. The schema has no persisted error-list column: only genuine fresh accepted validation proves
  an empty error set. No original status or diagnostic is manufactured. The canonical stored model digest and the
  freshly rederived projection must also agree.
- The exact finalized submission is read without listing all submissions. Its canonical persisted manifest digest,
  the canonical coverage calculation and the complete persisted coverage must agree. Case-fold warnings come unchanged
  from the canonical validator, not the link or a synthetic warning.
- The trusted baseline comes only from an audited current published operation's atomic receipt and sign-off, agrees
  with that stored version's warnings and `rs_trusted_fingerprint`, and is reread at release. No publication plus no
  trusted rows positively derives an empty set; withdrawal positively means no current published baseline. An orphan
  baseline or published pointer without audited evidence is an integrity refusal.

## Actual display support and file previews

At base `d35a9a11140491a4f58b0ceae216b71c880aaf59` there is **no `HostedCaseView` component**. The actual hosted chronology
Svelte page is rendered through `svelte/server`, using the genuine validated projection, existing chronology query helpers
and immutable original attribution. Its ready/table/row markers are checked. The overview is only a summary; it does not
render required analysis. All other required datasets are **unsupported**, even when schema-valid. Required sections are
the manifest's real required-file flags plus the canonical `REQUIRED_DATASETS` policy (chronology), not invented feature
keys, optional residuals or an empty list. No JSON dump substitutes for a supported view. Full v5 packages therefore HOLD.

Every file asset is required for preview readiness; missing and embedded assets remain explicit pending entries. Each
PDF, including aliases, passes its exact authorized byte-verified **unchanged original** to the checker with client, case,
candidate, version, asset identity and digest. A genuine `rendered` result also needs a renderer version, positive page
count and no failure reason. Supplied inline document/page references are retained and checked against those pages;
unmatched/malformed page references hold, never clamp or acquire generated pagination. Null checker, failed/pending
checker, unsupported media or download-only bytes hold. No converted-preview mapping is claimed: the current storage
schema has no faithful source/page mapping to verify. Non-PDF preview support remains HOLD, not download-only acceptance.

## Parent integration obligations

1. **Digest contract mismatch:** canonical validation uses `sha256:<hex>` for `diagnosticsSha256`; current publication
   `rules.ts:checkSnapshot` accepts bare hex only. This reader preserves the exact canonical/stored digest. Parent must
   fix that guard and its tests; until then the existing HTTP controller refuses these genuine snapshots with 503.
2. Compose this factory per request with genuine import validation, primary DB, matching bucket, request audit/session,
   explicit matching budgets and native checker. Keep it null if those dependencies are not available.
3. Own the final coherent sign-off/publication fence. These observations do not make external Clerk, renderer policy,
   baseline and D1 globally atomic. Persist/version readiness/configuration dependencies and advance candidate generation
   in their owning write transaction. Baseline observations detect changes across this read, not an ABA after release.
   The final parent fence and exact-generation SQL predicates remain mandatory; this reader adds no process lock.
4. Expand supported hosted views before accepting their required datasets. Add genuine native file/page/fidelity evidence;
   changing a required flag, swallowing a diagnostic or installing a successful unit checker is not acceptance.

## Light checks

Run with Bun 1.4.2 through `scripts/agent-tools/receipt`:

- `bun run --bun test --config tests/hosted-foundation/publication-material/vitest.config.ts --maxWorkers=1`
- `bun node_modules/typescript/bin/tsc --noEmit -p tests/hosted-foundation/publication-material/tsconfig.json`

The tests use real committed schemas, original intake, submission persistence, staging, canonical validation, immutable
native repository, publication ledger/atomic SQL and actual Svelte chronology SSR. SQLite, in-memory R2, identity/audit and
**explicitly labelled checker doubles** are component seams, not renderer acceptance. A source-only scratch graph runs
the actual hosted import guard over this otherwise-uncomposed module, including the existing crypto-only host exception.
No original source/tests/schema were changed. Native rendering, browser, full gates/build/suite and providers are UNRUN.
