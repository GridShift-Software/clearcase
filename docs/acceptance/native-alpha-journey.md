# Native alpha user-journey acceptance suite (prepared, unverified)

**Status: PREPARED / UNVERIFIED.** The suite is source, with unit tests of its own judgements over an in-process self-test world. It has not been run against any deployment, Clerk session, browser, D1, R2 or Worker. A green unit run here says the *runner* catches seeded defects; it says nothing about the deployed system. Nothing in this page is a gate result, a native PASS or a funded-admission claim.

The suite is the executable form of the first native user journey: a client uploads a synthetic PDF, an operator downloads the manifest and the original, imports a precomputed synthetic package privately, a human signs off the exact candidate, the operator publishes, the client reads the chronology and the cited PDF and writes a note and an annotation, and the facts survive a restart. Words follow [GLOSSARY.md](../../GLOSSARY.md). The linkage rules it rehearses are in [the native integration contracts](../hosted-foundation/native-integration-contracts.md).

## What it refuses to be

- No fake authentication: the suite never signs anyone in, mints a session, calls a Clerk API or accepts a header, token or test identity. Every actor is a **real Clerk development session**, captured by the parent in a real browser and supplied as a Playwright storage-state file. A route that bypasses sign-in (a test login, an identity double) is refused by name, whoever supplies it.
- No test double at the acceptance boundary: `run.ts` always uses the real `fetch` against the real origin. The self-test world (`world.ts`) is imported only by this directory's unit tests, and `static.test.ts` fails if any production-path module imports it or if the command line gains an injection point.
- No skip-as-pass: a missing URL, session, route or confirmation is a **HOLD** with exit code 3, naming the variable. Nothing is sent, and a HOLD is never a pass.
- No model or recipe processing: the processed package is **precomputed synthetic output** from GRS-10's own converter over an invented v5-shaped workspace (one invented PDF, zero diagnostics). No case document, private case or secret is read or written.
- No invented portal: ports whose routes no accepted document fixes have no default (below).

## Run

```sh
# one real, private environment per run; values are never printed and never enter a report
export CLEARCASE_JOURNEY_BASE_URL=https://<native hostname>   # https origin only; not localhost, an IP, workers.dev or pages.dev
export CLEARCASE_JOURNEY_EXPECTED_SHA=<40-hex commit the deployment was built from>
export CLEARCASE_JOURNEY_CASE_ID=<a fresh, provisioned case with no submission>
export CLEARCASE_JOURNEY_FOREIGN_CASE_ID=<a provisioned case in this deployment that client A has no grant to>
export CLEARCASE_JOURNEY_OUT=/absolute/dir/outside-the-checkout-or-under-.local
export CLEARCASE_JOURNEY_CLIENT_A_STATE=/private/client-a.json        # real session of client A (upload and read grants)
export CLEARCASE_JOURNEY_OPERATOR_B_STATE=/private/operator-b.json    # real session of operator B (operate and publish grants)
export CLEARCASE_JOURNEY_OTHER_CLIENT_STATE=/private/other-client.json # real session of the other client's application
export CLEARCASE_JOURNEY_REVOKED_STATE=/private/revoked.json          # a client A session that was revoked before this run
export CLEARCASE_JOURNEY_ROUTES=/private/routes.json                  # see "Route contract"
# optional: CLEARCASE_JOURNEY_REVIEWER_STATE (a second operator session that signs off, so no self-approval is claimed)

bun tests/native-alpha-journey/run.ts upload-import      # exit 4: AWAITING-HUMAN-SIGNOFF; prints the candidate identity and its digest
# a human opens the private preview, reviews that exact candidate, then:
export CLEARCASE_JOURNEY_HUMAN_SIGNOFF_IDENTITY_SHA256=<digest printed above, typed by the human>
export CLEARCASE_JOURNEY_HUMAN_REVIEWER_REF='<short non-secret label of the reviewer>'
bun tests/native-alpha-journey/run.ts signoff-publish    # exit 0 only if every check passed
# the parent restarts or redeploys the same revision, then:
bun tests/native-alpha-journey/run.ts after-restart
bun tests/native-alpha-journey/run.ts verify             # JOURNEY PASS <sha> only when all three phases agree
```

Run the commands through `scripts/agent-tools/receipt` so each leaves a receipt. Exit codes: 0 PASS, 1 FAIL, 2 usage, 3 HOLD, 4 awaiting the human sign-off. The parent alone runs this; it uses the network.

**Sessions.** Each actor signs in through Clerk in a browser (an invited development user; Clerk development test addresses accept their fixed code) and the parent saves the browser's storage state outside the checkout. The loader refuses a file inside a tracked path, an expired or other-host cookie, a file that is not a storage state, and two actors that share the same cookies. Cookie values are used only in the `Cookie` header and appear in no output. The revoked session must really be revoked (for example, signed out everywhere in Clerk) before the run: the suite cannot revoke it and cannot tell a merely expired one from a revoked one, so the parent records how it was revoked.

**Human step.** Phase 1 ends clean with `AWAITING-HUMAN-SIGNOFF`. Phase 2 starts only when the person who reviewed the private candidate types back the identity digest phase 1 recorded; a different digest is a HOLD. The sign-off is recorded under that human's real session. If `CLEARCASE_JOURNEY_REVIEWER_STATE` is absent, operator B both imported and signs, so the run claims and records a **self-approval**, which the publication contract allows only explicitly. The report says which.

## Route contract

Defaults exist only for routes that exist at the base commit or in a prepared worker's document: `/health`, `/sign-in`, the client intake routes (`/client/intake/{caseId}/submissions[/{operationId}]`), the case routes (`/cases/{caseId}`, `/cases/{caseId}/views/{resultsVersion}/chronology`, `/cases/{caseId}/notes?/add` and `?/delete`, `/cases/{caseId}/originals/{assetId}`) and the publication routes (`/operator/publication/{caseId}/{signoffs,publish}`).

No default exists for the operator submission manifest and download (`operator.submission.get`, `operator.submission.download`), the private import and preview (`operator.import`, `operator.preview`) or the complete export (`recovery.export`): their owning workers' final documents are not accepted yet. Supply them in a `clearcase.native-journey-routes/1` file, taking the paths and response shapes from those documents:

```json
{ "schema": "clearcase.native-journey-routes/1", "ports": {
  "operator.submission.get": { "method": "GET", "path": "/…/{caseId}/{operationId}", "captures": { "files": "/pointer/to/files", "stage": "/…", "revisionId": "/…", "manifestSha256": "/…", "manifestBase64": "/…" } },
  "operator.submission.download": { "method": "GET", "path": "/…/{caseId}/{operationId}/{assetId}" },
  "operator.import": { "method": "POST", "path": "/…/{caseId}", "contentType": "application/zip",
    "captures": { "candidateId": "/…", "identity": "/…", "newWarnings": "/…" } },
  "operator.preview": { "method": "GET", "path": "/…/{caseId}/{candidateId}" },
  "recovery.export": { "method": "GET", "path": "/…/{caseId}", "actor": "operatorB",
    "exportContract": { "document": "docs/path/to/owning-accepted-contract.md", "transport": "zip", "manifestPath": "manifest.json",
      "schema": { "pointer": "/…", "value": "<owning schema identifier>" },
      "captures": { "caseId": "/…", "resultsVersion": "/…", "files": "/…" },
      "fileCaptures": { "kind": "/…", "assetId": "/…", "path": "/…", "archivePath": "/…", "sha256": "/…", "size": "/…" },
      "originalKind": "<owning original kind>", "previewKind": "<owning published preview kind>" } },
  "viewer.pdf": { "method": "GET", "path": "/…/{caseId}/{assetId}" } } }
```

Placeholders are `{caseId}`, `{operationId}`, `{assetId}`, `{resultsVersion}`, `{candidateId}`; captures are JSON pointers. `identity` must hold exactly the nine sign-off identity keys (`linkId`, `submissionRevisionId`, `submissionManifestSha256`, `resultsVersion`, `manifestSha256`, `packageInputRevisionId`, `diagnosticsSha256`, `validatorVersion`, `snapshotRevision`); no field is guessed. `viewer.pdf` is optional: without it the report lists the check as `NOT CHECKED`.

**Submission lineage.** `operator.submission.get` must expose the finalized `stage`, `revisionId`, SHA-256 and base64 of the **exact persisted manifest bytes**, as well as its files. These are authoritative server readback fields, not values copied from the imported candidate. The runner decodes the bytes, hashes them without reserialization, and compares their parsed manifest to the finalized upload, including case and operation. It then binds the import's submissionRevisionId and submissionManifestSha256 to those observed values before presenting human sign-off. Missing captures HOLD before requests; absent or false response fields fail before import. If the owning port cannot expose the exact persisted bytes, it is not ready for this journey.

**Complete export.** The example above is a projection template, not an accepted production schema. The parent must obtain the owning worker's accepted document and supply its ZIP manifest path, schema identifier and JSON pointers; there is no default export schema. A missing or unsupported contract HOLDs before requests. The synthetic schema in `world.ts` is only a self-test fixture and must not be used as a production contract. `containsOriginal` is a legacy hint with no acceptance effect.

The runner decodes stored or deflated ZIP entries with the package reader (including path, duplicate, size and CRC checks). It validates the manifest's schema, case and exact published resultsVersion, its complete file inventory, every file's size and SHA-256, and the exact finalized original asset id/path/bytes. File kinds must be originals or published previews, not Notes or recovery-backup records. This run does not select Notes. Unknown fields may exist in the owning manifest but cannot substitute for the required projections. ZIP64 and other unsupported formats fail closed; an owning contract needing them requires a decoder extension, not a containment waiver. This runner's archive expansion cap is 64 MiB for the small synthetic journey. Temporary decode files are private and removed on success or failure. These checks run again after restart.

The foreign case is required, not optional: provision it without any client A case/upload grant. Missing configuration HOLDs before requests, so neither unknown-versus-ungranted comparison can silently disappear.

The route paths and bodies named here for the publication and notes routes come from the prepared sign-off/publication and case-overview documents. If a worker changes a route, change the routes file, not the code.

## What the phases check

**1 upload-import.** Exact deployed revision at `/health` (production profile, clean, cloudflare, no gate, no identity double); the sign-in page offers no test identity; an unsigned case request is refused; the case has no earlier submission; client A declares and uploads the PDF and the finalized manifest matches its path, sha256 and size, results `none`; a read and a replay return the same immutable manifest; adverse: a reused upload id, an operator, an outsider, a revoked session, an unknown case and a cross-origin write are all refused and the case still holds exactly one submission; operator B reads the manifest and downloads the exact original with safe headers, and client A and outsiders are refused with none of its bytes; B imports the precomputed package and the candidate identity carries exactly the supplied package's resultsVersion, manifest sha256 and inputRevision id; the private preview works for B only; the client sees no results and the unpublished version is 404.

**2 signoff-publish.** The sign-off's adverse cases (outsiders, a stale identity, a readiness flag, a wrong self-approval claim, a skipped new-warning acknowledgement) change nothing, the unpublished version stays private after each; the human's sign-off (201) and its replay (same sign-off); publish refusals (outsiders, an unknown sign-off, a stale expectation) change nothing; the real publication, its replay and a conflicting second publish; then, as the client, the published overview, the chronology row, a citation link to a listed original (never guessed), the exact PDF bytes, HEAD, a Range read and the optional viewer; a note and an annotation, a replay that stays one write, a stale delete that changes nothing, a cross-origin and outsider note write refused; the refusal sweep (anon, other client, revoked) over eight client and operator targets plus an unknown case alike to a foreign one; the complete export; the exact-version readback, which must equal the readback taken before the stale delete and the whole sweep (preservation); and the revision again.

Every snapshot request must succeed with HTTP 200 and the page must show the exact published version. A failed snapshot records a failed observation and cannot establish preservation or restart equality, even when the error body contains the previous healthy content.

**3 after-restart.** The same revision, then the same readback facts (originals, chronology, notes, publication) read again and compared exactly; the PDF's bytes; the export; refusals again.

`verify` accepts the journey only if all three reports and both readbacks parse exactly, name one commit, case, run and host, the human's confirmed digest equals phase 1's, and the facts match.

## Readback and report parsers

`readback.ts` parses one canonical, digest-sealed document (`clearcase.native-journey-readback/1`): exact keys, sorted lists, canonical bytes and one final newline. It refuses an unknown or missing key, a bad type, a digest that does not seal the body, non-canonical or reordered bytes, and any secret-looking text (a JWT, a Clerk key or session id, a bearer or cookie value, an e-mail address). `report.ts` does the same for the phase reports and refuses a verdict that does not follow from its observations (a hand-edited PASS over a failed check). These parsers are unit-tested with adverse examples.

## Real boundaries not exercised

UNRUN: real Clerk sessions and the sign-in flow; the deployed Worker, D1, R2 and the Cloudflare custom domain; a browser (the suite reads server-rendered HTML and bytes with `fetch`; script, CSP enforcement and PDF.js rendering in a browser are not driven, and Playwright is not a root dependency, so this suite adds none); the real grant policy, revocation, audit and publication adapters; the owning workers' operator, import, viewer and export routes (their ports are unresolved until supplied); a real restart. The self-test world is not evidence for any of these.

Not covered, by design or for now: withdrawal (it would end the journey); a tampered or invalid package import (the effect of a rejected import on stored records is not specified yet); a second submission; the notifications; billing, deployment and account actions.

## Parent handoff

1. Supply `CLEARCASE_JOURNEY_ROUTES` from the final operator-download, private-import, viewer and recovery documents, then run the phases through receipts.
2. Provision the fresh case, grants and the four (or five) sessions; record how the revoked session was revoked.
3. Add `tests/native-alpha-journey/**/*.test.ts` to the root Vitest include, or keep the directory's own config: `bun --bun x vitest run --config tests/native-alpha-journey/vitest.config.ts`. A type check: `bun --bun x tsc -p tests/native-alpha-journey/tsconfig.json`.
4. The acceptance run is the parent's alone: it uses the network and real sessions.
