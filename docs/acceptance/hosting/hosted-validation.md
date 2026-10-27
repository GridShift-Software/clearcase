# Pure hosted package validation adapter

`src/lib/case-package/hosted-validation.ts` provides a synchronous, storage-neutral adapter for the parent native results importer:

```ts
validateHostedPackage({
  files: ReadonlyMap<string, Uint8Array>,
  originals: OriginalFacts,
  limits?: Partial<Limits>,
}): {
  result: ImportResult;
  caseMismatch: readonly { ref: string; fingerprint: string }[];
}
```

`OriginalFacts` is the trusted type from `src/lib/results/hosted/project.ts`; `Limits` and `ImportResult` are the existing case-package types. This is not an HTTP endpoint or an originals verifier. Never populate facts from request fields, package status claims, object presence, size alone, ETags or a stored projection's unverified claims.

## Validation and identity

The adapter snapshots the bounded memory transport, then uses the existing `validateSnapshot`, `DiagSink`, diagnostic fingerprint/digest functions and `Candidate`. It checks manifest and file identities, schemas, records, citations, links and the user-work boundary with the canonical validator, without rewriting case IDs, refs, manifest bytes or resultsVersion. Unlisted files are diagnosed and never enter the candidate snapshot. A rejected package never acquires a candidate. No package error is waived by originals facts.

Only after package validation succeeds are trusted facts compared with indexed originals. Missing facts produce canonical `ORIG_MISSING` warnings and unavailable mappings. Package-declared missing assets remain missing even if a fact exists. Cited unavailable originals (including embedded descendants) get canonical `CITE_TARGET_NO_ORIGINAL` diagnostics. Size and sha256 disagreements reject with canonical `ORIG_FINGERPRINT_MISMATCH`; actual-size and unique-real-path total bounds apply too.

A usable fact must have a safe non-reserved real path, lowercase sha256, nonnegative safe integer size, the indexed media type, a boolean sniff result and a consistent status/name rule: `verified` names the exact path; `case-mismatch` names a different path with the same case/NFC fold. Malformed/inconsistent facts and contradictory fingerprints for one real path remain unavailable, never verified. These checks do **not** establish where a fact came from or whether a folded lookup was unique. Only the trusted caller can establish that.

For a genuine fact marked `case-mismatch`, the message, assets.json pointer, subject and indexed sha256/size/path identity are identical to `originals.ts`. `downloadOnly` reproduces its canonical content-type diagnostic; this flag must come from sniffing the verified original bytes against that same media type. The adapter never invents a byte fingerprint or treats a presence check as one.

`result` has the canonical verdict, complete diagnostics, counts, diagnostic digest, validator version, uncapped warning/error fingerprints and immutable candidate. All baselines are `new` (this API accepts no trusted baseline). The result and its diagnostic objects/collections are frozen; candidate bytes are defensive copies and parsed values/mappings are frozen. `caseMismatch` is separately frozen and sorted by ref, with **every** emitted `ORIG_CASE_MISMATCH` ref/fingerprint pair, even beyond `diagnosticsPerCode` and even when another original rejects the import. It is lineage input, not publication authority.

## Limits and runtime boundary

Defaults and merging come from the existing [results-package bounds](../../results-package.md#bounds) and `withLimits`, not a hosted-specific default-accept path:

| Active bound | Default |
| --- | ---: |
| `manifestBytes` / `fileBytes` / `packageBytes` | 4 MiB / 64 MiB / 2 GiB |
| `packageFiles` / `datasets` / `assets` | 8,192 / 512 / 500,000 |
| `originalBytes` / `originalsTotalBytes` | 8 / 32 GiB |
| `diagnosticsPerCode` | 2,000 listed; all instances fingerprinted |
| `parentDepth` | 4 |

Supply trusted, valid lower budgets as appropriate for the parent request. Package file-count/total-byte bounds include unlisted safe paths before copying. Original totals deduplicate by real path, not ref. As in the canonical validator, strict-JSON, relative-path and ref helpers retain their own fixed default bounds; arbitrary overrides of those `Limits` fields are not additional enforcement. ZIP/archive limits do not apply to an already materialized map. `validationDeadlineMs` is not enforced here: this pure synchronous adapter reads no clock and has no abort/progress/I/O API. The parent must bound receipt, buffering, original verification and execution separately; it cannot interrupt a synchronous call with a same-thread timer.

The module imports no filesystem, Node/Bun builtin, SDK, network, storage or processing recipe. Runtime dependencies are the existing pure case-package modules and TypeBox. The existing hash/diagnostic helpers transitively use `node:crypto`, which the current hosted graph explicitly allows as Workers-provided crypto; this is not a browser-only bundle or a claim of workerd acceptance. Type-only imports of `OriginalFacts` and `OriginalMapping` add no runtime capabilities. No existing library, schema, storage or parent runtime file changes are required by this adapter.

## Remaining parent hooks

1. Authorize the exact client/case/submission import and verify the received package identity. Keep its case ID and resultsVersion unchanged.
2. Read real case-scoped finalized D1 associations and fully verify the selected R2 objects (for example through `readOriginalFacts`). Choose exact submission links when required. Do not turn a refused, ambiguous, over-budget, unreachable or unverified read into a positive fact. Keep the verifier's refusal/retry policy intact.
3. Pass only the resulting trusted facts and bounded package bytes here. Handle `reject` without staging. Persist the exact snapshot and canonical validation identity/diagnostics; use the uncapped mismatch mapping together with trusted original attribution for exact lineage, not the capped diagnostic list.
4. Stage/project privately from the accepted candidate's mappings and validation counts; do not reintroduce facts the adapter left unavailable. Apply acknowledgement policy and separate exact-version preview, sign-off and publication checks. This adapter neither stages nor proves originals nor publishes. A missing-original warning is not preview readiness or permission to publish.

## Scoped offline evidence

The private config includes only `tests/hosted-foundation/hosted-validation/**/*.test.ts`, with one worker. Tests compare **all** public `ImportResult` and candidate values against the real canonical `importCandidate` over synthetic temporary case folders; that is the case-package library entry point, not the local application's storage-owning `importPackage` service. Coverage includes the full synthetic v5 corpus, complete adverse diagnostic identities, cap overflow, original missing/case/NFC/ambiguity/content-type cases, byte mismatches, limits, immutability and acknowledgement binding. A source-graph test also checks the adapter's actual runtime dependencies.

```sh
scripts/agent-tools/receipt --name hosted-validator-targeted -- \
  unshare -rn env OUTER_UID="$(id -u)" OUTER_GID="$(id -g)" \
  tests/e2e/pilot/offline.sh bun run --bun test \
  --config tests/hosted-foundation/hosted-validation/vitest.config.ts --maxWorkers=1
scripts/agent-tools/receipt --name hosted-validator-tsc -- \
  bun run --bun tsc --noEmit -p tests/hosted-foundation/hosted-validation/tsconfig.json
```

Receipts and the prepared report record the exact tested commit. Real D1/R2/Clerk/provider acceptance, workerd, browser, deployment, full suites and integration gates are **UNRUN** here; they remain the parent's responsibility. No real case data or manual processing recipe was used.
