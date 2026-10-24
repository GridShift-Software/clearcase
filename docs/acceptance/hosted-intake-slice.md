# Hosted client intake: single-file PDF slice (GRS-137)

Status: PREPARED, UNVERIFIED. The module, routes and component tests exist. Nothing is composed into the hosted entry, so every intake route answers 503 `intake-unavailable` on a deployment. This is not a GRS-137 checkpoint, a GRS-28 upload, or a Cloudflare PASS.

## What a client can do

A signed-in client sends one PDF to a case that already exists. If the upload finishes, the file becomes one finalized **submission**: an immutable input revision of the case. A file sent later becomes a new submission. Submissions are never merged or overwritten. There is no folder upload, no resume, no multi-file submission, no processing queue, no notification, and no automatic publication.

## Routes (`deploy/client/routes/client/intake/`)

| Route | Method | Body | Answer |
| --- | --- | --- | --- |
| `/client/intake/[caseId]` | GET (page) | | Upload form and the case's submissions, each with its stage |
| `/client/intake/[caseId]/submissions` | GET | | `{submissions: SubmissionView[]}` |
| `/client/intake/[caseId]/submissions` | POST | JSON `{operationId, path, size, sha256, mediaType}` | 201 `received` (200 on a repeat) |
| `/client/intake/[caseId]/submissions/[operationId]` | PUT | raw `application/pdf`, the declared bytes | 201 with the manifest (200 on a finalized replay) |
| `/client/intake/[caseId]/submissions/[operationId]` | GET | | `SubmissionView`: stage, manifest or null, download handoff |

Every request is checked in this order. A write needs the exact Origin and the exact content type. Then the composed ports must be present, or the answer is 503. Then the caller must have a verified identity of the deployment's own client (401 `unauthenticated` or `wrong-client`), and the revocation check runs. Then a write needs the separate **upload capability** for the URL's case (`AuthorizeUpload`, 403 `forbidden`; an unknown case gets the same answer), and a read needs `Identity.authorize({operation: 'read'})` (404). Only after all of that does the controller read a body, a row or an object.

## Limits and checks

- Body sizes come from the trusted budget `{maxMetadataBytes, maxFileBytes}` (`intakeBudget()`). It has no default. Both bodies are read incrementally against the bound, and `Content-Length` is never trusted.
- The file body must be exactly the declared size. A longer body gets 413. A shorter one gets 400 `incomplete-body`: the upload was interrupted, the whole file is sent again with the same `operationId`, and nothing is stored.
- The actual bytes are checked: their SHA-256 must equal the declaration (422 `digest-mismatch`), and they must start with a PDF header and end with an end-of-file marker (422 `not-a-pdf`). GRS-115's `put` checks them again.
- The path must be relative and normalized to NFC. It may not be absolute, name a drive, contain an empty, `.` or `..` segment, a backslash, a control, bidi or invisible character, or a trailing dot or space. The file name must end in `.pdf`. The path is provenance only: no object key is derived from it.

## Order of durable effects (PUT)

1. `originals.put`: GRS-115 writes the bytes once and verifies them.
2. `repository.markStored` records that the store acknowledged them.
3. `originals.finalize` binds the original to the case. It can then be read at `/cases/[caseId]/originals/[assetId]`.
4. `repository.commitRevision` records the revision and its file in one D1 batch, then reads them back.

Any fault answers 503 and never reports success. A fault in step 4 answers `manifest-unrecorded`. A retry with the same `operationId` and bytes recovers the same revision, because the revision id is derived from the operation (`subrev-<operationId>`). Changed bytes under an operation get 422; a changed declaration gets 409 `operation-reused`.

## Schema (`src/lib/submissions/migrations/0001_submissions_intake.sql`)

Tables `submissions_upload`, `submissions_revision` and `submissions_file`. Triggers refuse any update or delete of a revision or file, any change to a declaration, any backward state move, and any delete of an upload. Sequences are per case. If two commits race for the same sequence, the batch fails and the retry takes the next one.

## Stages shown

`received` means declared, with no bytes stored. `stored-not-finalized` means the bytes are stored but finalization did not finish, so the client sends the file again. `finalized` means the submission is recorded; it has no results and is ready for the service team to process manually. `results` is always `none`. Nothing claims processing.

## Unresolved handshakes (parent or user decision)

- Upload capability: GRS-114 offers `operate` and `publish` only. There is no client-upload capability for the parent to adapt to `AuthorizeUpload`.
- Submission identity and results identity: a results package's `inputRevision` digests the converter's input (the workspace HTML: `role`, `sha256`, `size`), not the client's submitted files. No existing contract says how a results package names the submission it came from. This slice adds no canonical hash. A manifest is identified by `revisionId` and its exact file `path`, `sha256` and `size`.
- `maxFileBytes` must not exceed GRS-115 `maxOriginalBytes`. `intakeBudget(v, {maxOriginalBytes})` refuses it.
- GRS-115's original key is the client-shared `orig/<sha256>`, and the case binding lives in its D1 provenance (115 recheck residual).

## Not run

No workerd, Miniflare, D1, R2, Clerk, wrangler, browser, full suite, build or gate run was made. The D1 and original-store doubles are unit evidence only.
