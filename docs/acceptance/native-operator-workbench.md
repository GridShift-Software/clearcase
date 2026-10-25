# Synthetic native operator workbench

Prepared UI and read helper, not processing or live acceptance evidence. Entry: `/operator/cases/[caseId]`.
Only synthetic submissions and already-processed synthetic results belong in this alpha.

## Operator steps

1. Sign in as staff with the case's explicit operate/download access. Open the workbench and refresh finalized submissions and candidates. A reserved upload is not a finalized submission.
2. Select the exact finalized submission. Inspect/download its persisted manifest and PDF through the existing audited download endpoints. This page never starts processing, claims a processing job, or asserts processing lineage.
3. Select the **root directory of an already-produced results package**, containing `manifest.json`, `assets.json`, and `datasets/*.json`. The browser preserves each file's UTF-8 text and constructs the existing import controller's exact JSON:
   ```json
   { "operationId": "<stable-operation-id>", "submissionRevisionId": "<selected-finalized-revision>", "files": { "manifest.json": "<exact UTF-8 text>", "assets.json": "<exact UTF-8 text>", "datasets/chronology.json": "<exact UTF-8 text>" } }
   ```
   See [the actual package contract](../results-package.md). JSON contents are not rewritten, normalized or processed. The UI supports at most 200 files and 24 MiB; the deployment's authoritative budget may be smaller. A BOM is preserved for the real validator to reject. ZIP, HTML case packs, PDFs, Markdown recipes, arbitrary extra files and malformed UTF-8 are not supported by this workbench's upload picker. ZIP support in the package library is **not** ZIP support in the native import controller.
4. Import privately. A refused or unlinked response is shown with its actual HTTP status/code/details; staging alone is not a linked candidate, sign-off or publication. Inspect the private candidate link/status. The advanced correction editor sends the existing `{operationId, reason, replacements:[{key,data}]}` DTO and cannot edit originals or generated datasets through the server's correction rules.
5. Select the candidate's finalized submission, refresh readiness, and review the exact identity and warning fingerprints. Any required section, preview or validation error holds sign-off. Supply a reason for each new warning, explicitly confirm self-approval when required, and type the exact reviewed resultsVersion. Click **Record exact sign-off**. This never publishes.
6. Refresh readiness with the returned sign-off id. Only the exact current, audited and non-invalidated sign-off enables publication. Explicitly select the expected pointer state (none/published/withdrawn, with its exact version when applicable), type the version to publish, and separately click **Publish**. The existing controller's atomic comparison/receipt rules remain authoritative. The page never infers the current pointer from a candidate, readiness response, sign-off, or pointer equality.

Draft reasons and correction text remain on refusals and stale reads. Writes disable inputs while in flight. Network/invalid-response/5xx failures retain the exact request in memory for an explicit unchanged retry, including its original operation id; the controller reconciles it. Do not reload during an uncertain operation: closing/reloading loses in-memory drafts/retry material. A confirmed controller response is displayed as such, not as proof of processing or a live deployment. No-JavaScript rendering explicitly refuses interaction. Imported text is escaped; there is no raw HTML rendering, package logging or client-side authorization.

## Readiness DTO and parent composition

`GET /operator/publication/[caseId]/readiness?candidateId=<id>[&signoffId=<exact-id>]` is private/no-store. `setReadinessComposition` in `src/lib/publication/hosted/readiness.ts` is its **own** per-request composition hook. It defaults to null/503. The parent must register a resolver against the **exact original Request** and supply that request's real `NativePublicationPorts`. The existing publication composition setter does not configure this one.

The helper requires verified staff of this client, current explicit `publish` authority, and current case `read-preview` access before snapshot/ledger metadata. Required audit intent/read writes precede release; audit failure releases nothing. After awaited audit/hash work it rereads the complete snapshot and requested sign-off, rechecks authority, and refuses changed material with 409. It uses `checkSnapshot`, `signoffBlocker`, `newWarnings`, and the existing canonical SHA-256 helper. Snapshots or arrays beyond the helper's bounds fail unavailable rather than truncate acknowledgements. The response contains only `{caseId, identity, materialSha256, blocker, requiredAcknowledgements, selfApprovalRequired, signoff}`. Sign-off observations contain only its id, bound identity, audit state, invalidation flag and actual effectiveness/staleness blockers. No signer details, audit envelope, storage keys, original text, signed decision or applied-publication claim are returned.

The browser checks identity against the selected finalized submission and candidate, and rereads readiness before every **new** sign-off/publication request. Changed identity, warnings, material, or sign-off observations refuse submission and require deliberate review again. An unchanged retry of an uncertain operation intentionally goes to the existing controller's reconciliation path, not a new client decision. These checks are UX, never authority.

At the assigned base there is no assembled publication snapshot-material adapter. The parent must provide the real candidate reader, fenced against candidate/link/validation/baseline/required-section/preview changes (including the D1 generation fence), and the existing exact atomic publisher/ledger/audit/authorizer. Missing material stays 503; this implementation does not fabricate readiness facts. The parent also owns real import stager composition, original-request runtime registration, D1/Clerk setup, navigation and final native browser proof. All mutations use direct same-origin JSON calls to the existing endpoints, preserving Origin enforcement; there are no server actions or cloned-request composition lookups.

## Bounded checks

Run in this checkout with Bun, through `scripts/agent-tools/receipt`:

- `bun run --bun test --config tests/hosted-smoke/operator-workbench/vitest.config.ts --maxWorkers=1` — private includes replace the root suite; synthetic unit ports, real helper/controllers, pure payload consistency and Svelte SSR checks.
- `bun run --bun node_modules/typescript/bin/tsc --project tests/hosted-smoke/operator-workbench/tsconfig.json --noEmit`.
- `bun run --bun node_modules/svelte-check/bin/svelte-check --tsconfig tests/hosted-smoke/operator-workbench/tsconfig.json --fail-on-warnings`.
- `bun run --bun check:hosted-imports`.

The adverse test changes warning-baseline material during an awaited audit without changing the displayed identity: readiness must refuse 409. Other checks cover absent hooks, original Request binding, grant/preview denial before metadata, audit outage, late session revocation, hard blockers, stale sign-offs, deliberate reasoned sign-off payloads, real-controller Origin refusal, and escaped server rendering. These are targeted unit/render checks, not acceptance-boundary evidence. Full suites, processing, provider calls, browser/workerd/full builds, real Clerk/D1/R2 and deployed publication/import boundaries are unrun here; the integration owner must prove them at its combined exact SHA.
