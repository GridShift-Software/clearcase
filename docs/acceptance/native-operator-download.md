# Native operator submission manifest and download

Status: PREPARED, UNVERIFIED. The module, routes and component tests exist. Nothing is composed into the hosted entry, so every operator submission route answers 503 `operator-download-unavailable` on a deployment. This is not a gate result, a native-flow PASS, a Cloudflare PASS or an accepted checkpoint. It grants no permission, and no test or document here changes one.

## What an operator can do

[ADR-0009](../adr/0009-manual-queue-and-candidate-import-contract.md): an operator downloads the complete submission with its manifest, processes it locally and later uploads a results package. This slice is the download half only, for **one finalized submission** (one PDF, the shape of [the intake slice](hosted-intake-slice.md)). It does not run, queue, claim, order, notify or label any processing, and it never writes. Nothing here says a case is "awaiting manual results": that label waits for real hosted proof.

## Routes (`deploy/client/routes/operator/submissions/[caseId]/`)

| Route | Method | Answer |
| --- | --- | --- |
| `/operator/submissions/[caseId]` | GET (page) | The case's finalized submissions, each with its manifest and download links |
| `…/finalized` | GET | `{submissions: OperatorSubmissionView[], pendingCount}`, finalized only, by sequence |
| `…/finalized/[operationId]` | GET | One view: the manifest, `manifestSha256`, `manifestHref`, `downloadHref` and the file's path, size and SHA-256 |
| `…/finalized/[operationId]/manifest` | GET | The exact manifest bytes (fixed key order) as an attachment; `X-ClearCase-Manifest-Sha256` equals `manifestSha256` |
| `…/finalized/[operationId]/download` | GET, HEAD | The complete PDF (200), or one range (206/416), as an attachment |

A download response names the case, submission, revision and file SHA-256 (`X-ClearCase-*`, `Repr-Digest`, a strong `ETag`), links the exact manifest (`Link: <…/manifest>; rel="describedby"`) and carries `Content-Disposition: attachment` with a header-safe name (the last path segment only, an ASCII fallback plus the exact UTF-8 name), `nosniff`, `Cache-Control: private, no-store`, a sandbox CSP and `Cross-Origin-Resource-Policy: same-origin`. The path is provenance in the manifest and is never put in a header.

## Authority, in this order

1. All of `authorizeOperate`, `repository`, `assets` and `audit` must be composed, or the answer is 503. The composition is request-scoped (`setOperatorDownloadComposition`); there is no default, double or in-memory substitute.
2. The case id and submission id must be well formed; otherwise 404 `not-found`, before any port.
3. The identity must be verified (401 `unauthenticated`) and belong to this deployment's client (401 `wrong-client`); a session revoked since sign-in is 401.
4. The principal must be `staff`. A client user never operates; the answer is the uniform 404.
5. **Both** must allow, for this case: `authorizeOperate({capability: 'operate'})` (the tenancy authorizer's explicit grant) **and** `identity.authorize({operation: 'read-original'})`. A staff, management or Global Admin identity with neither grant reaches nothing. A refusal of either, an unknown case, a malformed id and an unknown submission of a granted case all give the identical 404 body: nothing tells them apart and this module read no row, manifest or object and wrote no audit event for the refused caller. A fault of the capability service is 503, never an allow.

Only then does the controller read a row.

## What is served

- Only an upload whose state is `finalized`. `received`, `stored` and `reserved` answer 409 `not-finalized` with `stage` `received` or `stored-not-finalized`, and release no manifest, hash or byte. The list counts them (`pendingCount`) without describing them.
- Only a submission that agrees with itself: its manifest names this client, case, operation and revision and exactly one PDF whose asset, path, size and SHA-256 are the upload's own; otherwise 503 `submission-inconsistent`.
- Download additionally checks the stored original's size, SHA-256 and media type (`assets.metadata`) against the manifest before it audits or sends anything (410 `changed-original`, 410 `missing-original`).
- `finalizedAt` in the manifest records the reserve time, not the final mark ([alpha contracts](../../src/lib/server/runtime/hosted/alpha-contracts.ts)); it is not proof of finalization or an SLA measure. The view repeats the manifest unchanged.

## Bytes

Only a single `bytes=a-b`, `a-` or `-n` range (at most 64 characters) is passed on; anything else is ignored and the whole file is served. The service's answer is checked against the manifest: a 206 needs a `Content-Range` whose total is the manifest size, the lengths must agree, and an unexpected status is 503 `asset-unavailable`. The body is streamed on demand through a guard that errors the stream if the service delivers one byte more or fewer than the declared length. Whole-file integrity is the assets service's contract (integrity-checked before the first byte); this module does not re-hash a stream.

## Audit

Every release is appended to the audit sink before anything is released: `operator.submission.list`, `.read`, `.manifest`, `.download` (kind `case` or `submission`, with the verified staff actor, the case id and the operation id). With the log unavailable nothing is released (503 `audit-unavailable`). A download whose service then fails appends a `failed` event best effort. The tenancy authorizer appends its own `case.operate` and `case.read-original` events and its own denials; this module does not duplicate denials.

## Not done, and handed to the parent

UNRUN: any real D1, R2, assets adapter, Clerk or Cloudflare boundary, the real tenancy authorizer and audit sink, `svelte-check` of `+page.svelte`, the full `tsc`, the build, the gate and a browser. The component tests use doubles (`tests/hosted-smoke/operator-download/doubles.ts`, reusing the intake tests' SQLite D1 stand-in).

Parent wiring, in files this slice does not own:

- Call `setOperatorDownloadComposition` from the hosted composition, returning `{clientId, authorizeOperate: authorizer.authorizeCapability, repository: d1SubmissionRepository(DB), assets: <request-scoped assets handle>, audit, now}`; return null when anything is missing. The assets handle should authorize `read-original` through the request's identity as `locals.assets` does.
- Add `tests/hosted-smoke/operator-download/**/*.test.ts` to the root `vitest.config.ts` include list (until then run `tests/hosted-smoke/operator-download/vitest.config.ts`, which replaces the root list).
- Decide where operators find the case page; no link to it exists yet.
- Hosted proof of the grant check, the audit record and a byte-for-byte download is still needed before any workflow label such as "awaiting manual results".
