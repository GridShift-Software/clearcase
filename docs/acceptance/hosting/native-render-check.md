# Native PDF preview inspection: prepared, real rendering UNRUN

This source implements `NativePreviewRenderChecker` from the unchanged internal
[`render-check-contract.ts`](../../../src/lib/viewer/hosted/render-check-contract.ts).
It does not add a route, a browser-supplied success API, or a publication bypass.
Only synthetic PDFs are in the alpha scope. Other media return `failed`; they are
not represented as supported file previews. This document is not renderer acceptance.

## Trusted factory and exact-file evidence

`createNativePreviewRenderChecker(options)` in
[`native-render-check.ts`](../../../src/lib/viewer/hosted/native-render-check.ts)
is asynchronous and returns the internal port or `null`. Supply the deployment's
raw primary-capable D1 (`withSession('first-primary')`), clientId, real BROWSER
binding, ASSETS fetcher, exact HTTPS appOrigin, reviewed PDF asset inventory,
all six explicit integer budget fields, and a trusted UTC clock `now(): Date`.
Missing bindings, budgets, invalid ceilings or pins return `null`, not a fallback.
Do not deserialize this factory, the port, its pins, or its successful outputs
from request JSON. The parent must authorize scope and load the candidate's
immutable required asset bytes/hash before calling `verify`.

The checker copies bytes and identifiers before awaiting, verifies SHA-256 and
size, and persists a reservation bound to client, case, candidate, resultsVersion,
asset, input digest/size, renderer version and a digest of that tuple. Success is
never inferred from a reservation. Only a genuinely complete, cleanly closed render
may create a separate immutable success receipt, with a bounded canvas transcript
and its digest. The insert and primary readback must commit and validate before
returning `rendered`; failed/partial renders never create this receipt.

Subsequent readiness, sign-off and publication snapshots **reuse** that exact-file
receipt without another browser launch or launch reservation. They first rehash the
supplied bytes and check size, client, case, candidate, resultsVersion, asset, input
hash and renderer fingerprint, then validate the saved transcript and current pixel/
page budgets. A missing/invalid receipt does not become a fake success. This caches
only immutable byte rendering: no identity, grant, authority, current generation,
readiness or publication decision is saved. The parent must still check the current
native generation and fresh read-preview/publish authority on every request, and
hold publication on `failed`, `pending` or an unavailable port. Receipts have no TTL,
cache-size default or reset API; finite launch quotas bound their creation rate.

`rendererVersion` is `clearcase.native-pdf/2;sha256:<digest>` derived from the actual
installed SDK version module plus its exact lock integrity, PDF.js main/worker pins,
full reviewed resource digest, and the actual source-owned HTML/CSP/render program.
Changing those inputs changes the fingerprint. Changes to the server-side receipt/
transcript algorithm must bump the explicit algorithm family. This pins the PDF.js
browser/worker program, not Cloudflare's managed Chromium binary, whose deployment
and operation remain part of the parent's real native acceptance. The new XFA
metadata check and required SDK-policy ID/output hashes in the owned HTML change this fingerprint,
so earlier (pre-hardening) receipts cannot be reused. The policy ID names a required
build policy, **not** proof that the parent applied it.

## Browser program, not a flag

The official Workers SDK is exactly `@cloudflare/puppeteer@1.4.0` in package.json
and bun.lock. No browser binary is installed or run here. It launches a new
session via BROWSER, without session reuse, keepalive extension or recording.
Provider guardrails use `allowedDomains: []` to deny all actual outbound HTTP(S).
Page interception fulfills only the source-owned document/module, exact input
PDF, and required pinned same-origin PDF.js resources. No request is continued.
Queries, redirects, other origins, private app routes and unlisted resources abort
and invalidate the check. ASSETS never receives a caller URL, cookies or auth.

The isolated page has a restrictive CSP, no caller markup and no imported case
text in its DOM. It loads pinned `pdf.min.mjs` and hash-checks pinned
`pdf.worker.min.mjs` before running those worker bytes in a real module Worker
through a source-owned blob. This is **not** PDF.js's fake-worker fallback.
`useWorkerFetch:false` puts resource fetching on the intercepted page; provider
guardrails remain the backstop for unexpected worker or browser network activity.
The page hashes the actual input again, opens it using PDF.js 6.4.299, and renders
**every** page at scale 1 using `page.render(...).promise`. For each page it reads
the complete canvas with `getImageData`, checks the readback size, and hashes the
pixels. Blank but valid pages need not contain nonwhite pixels. Neither pixels
nor screenshots are returned or persisted. The checker validates total page count,
sequential completions, dimensions, aggregate pixels, input identity and renderer
version before persisting a success receipt and producing `rendered`.

PDF scripting, eval, XFA and WASM are disabled. No annotation/text DOM layer is
constructed. Before reading any page, `getMetadata().info.IsXFAPresent` must be
exactly `false`: pure or mixed XFA, missing/unknown metadata and metadata errors fail.
`isPureXfa` is only an additional check; with `enableXfa:false`, PDF.js suppresses
that flag even for pure XFA with fallback PDF pages. XFA is never enabled to detect
it, and fallback pages cannot certify XFA content. JavaScript actions, parser/render
errors, recovery warnings, password-required/unsupported documents, partial results
and exceeded limits fail.
Warnings are counted without retaining/logging their text, in the page and worker.
Font faces/system font substitution are disabled; pinned font resources and PDF.js
canvas paths are used. This is a bounded rendering check, not a claim of semantic
PDF fidelity, OCR, arbitrary format coverage, or a full PDF conformance validator.

## Limits and durable admission

All limits are mandatory, positive safe integers. Hard ceilings (the parent may
only narrow them): 4,000,000 input bytes; 8 pages; 4,000,000 **aggregate** canvas
pixels; 20,000 ms whole-run deadline; 3 launches/case/day; 4 launches/client/day.
A case limit of 3 needs the case-limit migration below; on the 0001 schema alone a
third same-case reservation is refused at admission (`render-admission-refused`).
Each dimension is at most 4096. Static responses are exact-length streamed and
hashed; unique pinned static bytes are capped at 8,000,000, and requests at 220.

The whole-run deadline covers launch, navigation, resource loading and evaluation,
not just an in-page flag. Launch/upgrade HTTP is aborted on expiry. workerd ties an
upgraded socket to its request's signal, so the expiry abort reaches an upgrade only
while it is in flight; the live transport closes only after termination. Late sockets
are closed; late browser/page results are never accepted. Finally attempts page
close (without beforeunload, at most 500 ms), then source-owned root CDP termination.
It obtains the browser target's CDP session and its pinned SDK root connection,
sends `Browser.close` directly, and requires both a matched empty success reply
**and peer disconnection** before our own disconnect/transport close. It never calls
the SDK's `Browser.close()` callback, which swallows failures via `.catch(console.log)`.
A resolved promise, local disconnect, missing/malformed reply or peer-only closure
is not proof of termination. Raw/coded failures cross this boundary only as failure
booleans, not provider/session errors in results or logs. Cleanup/disconnect faults
and unknown outcomes hold without a receipt; the consumed reservation is retained.

### Navigation observations (diagnostic only)

A failed or pending result that reached `page.goto` carries one `navigation` observation, so a `render-failed` at stage `navigation`
can be told apart: `goto` rejected or resolved, whether the source-owned document's `respond` was acknowledged, the class of the FIRST
violation and, after a rejection, a token from a closed `net::ERR_*` table (`generic` otherwise, never the message or URL). It reads
state the run already holds. It adds no launch, request, protected read, audit or cache, and it changes no limit, pin, guardrail,
cleanup rule, reason or stage. The facts are read once when the main run ends (deadline or settle), before abort and cleanup; a goto, document
acknowledgement or violation that cleanup causes later never changes them, so a `goto` still pending at the deadline stays `pending`. A rendered result has none. The scripted-peer tests in `sdk-boundary.test.ts` show the four known causes
(goto rejected before interception, favicon request, `data:` icon request, module page error) now report differently; they are not proof of
what the native browser does. The Chrome major is not recorded: `browser.version()` is a new CDP round trip and failure dependency.

The total cleanup budget is 2 s, including local transport/disconnect release.
A stuck page close cannot prevent the root-CDP attempt. Late SDK results cannot
issue cleanup commands beyond the original run deadline plus 2 s; they only release
local resources after that. The launch explicitly pins keep_alive=60,000 ms (the
documented default, not an extension). Failure to complete cleanup cannot yield
`rendered`. A default SDK wait cannot extend our live transport beyond cleanup.

Cloudflare documents a **60 s idle timeout**, not a hard maximum session lifetime.
Therefore admission charges **maxRunMs + 2,000 + 60,000 ms per launch**, including
successful launches; no refunds or heartbeat keepalives. At hard ceilings that is
82 s/launch and 328 s/client/day, not the full account allowance. A persisted
client lease prevents overlapping launches, survives Worker crashes/restarts and
also exceeds Free's one-new-browser-per-20-seconds limit. The final lease-sized
window before UTC midnight is refused, so the idle tail is not charged to the
wrong day. Clock rollback cannot reopen an earlier day. Only a monotonically newer
UTC day resets counts; case/client limits and receipt insertion are one statement
with transactional triggers. A missing migration or ambiguous D1 commit holds work
without launching. Receipt identities are immutable; there is no reset/refund API.

Apply owned [`0001_preview_render_work.sql`](../../../src/lib/viewer/hosted/migrations/0001_preview_render_work.sql)
through the parent schema assembler, never in a request. Then apply
[`0002_preview_render_case_limit.sql`](../../../src/lib/viewer/hosted/migrations/0002_preview_render_case_limit.sql)
(native packet `0004`, see [native-runtime-migration.md](native-runtime-migration.md)). It rebuilds
npr_reservations and npr_case_days with case CHECKs of 1..3, copying every reservation and
counter back unchanged and recreating their indexes and triggers exactly; the client ceiling
stays 4 and success receipts are not touched. It creates npr_client_days,
npr_case_days, npr_reservations and npr_success_receipts. Counters retain one row/client
and one row/case. Immutable reservations and successful transcript receipts each grow
by at most four/client/day. Success insert guards require the exact launch reservation
and completion window. Receipts contain only identifiers, hashes, dimensions and
completion metadata, not bytes, URLs, credentials, extracted text or authority flags.
Reservation and receipt updates/deletes are refused. BEFORE INSERT guards also
reject conflicts through **all** receipt unique keys and reservation tokens before
SQLite REPLACE can silently delete an old row (even with recursive_triggers off).
An entirely identical receipt insertion is an ignored no-op, never a replacement;
verified exact-file readback/reuse remains idempotent. All four tables are WITHOUT
ROWID, closing the alternate rowid replacement identity. Counter inserts reject
conflicts; updates must retain identity and equal the immutable reservation
projection, with no day rollback, same-day refund or lease shortening. Counter
deletes, forged future resets and direct quota-row fabrication fail. The legitimate
reservation trigger uses atomic UPDATE/conditional INSERT for counters, so it needs
no replacement bypass or mutable authorization flag. Do not prune/reset to retry.

**Account allocation is a parent deployment responsibility.** Free is 10 minutes/day
and three concurrent browsers **per account**, not per client Worker. Reserve at
most 480,000 worst-case ms/day across *all* client deployments and other browser
users, with at most three client leases active at once. One explicit conservative
three-client alpha configuration is maxRunMs=15,000 and both daily launch limits=1
per client (231,000 ms total/day), with the other fields narrowed as needed. Do not
configure every client at the four-launch ceiling on the same account. Do not use
paid changes, quota upgrades, account/limits probes, or API retries to bypass holds.
A killed Worker cannot guarantee Browser.close delivery; the charged idle tail and
provider-enforced Free limit are the fallback, not evidence of confirmed closure.

## Scaled PDF evidence (real-export U9; ADR-0014 Proposed)

`createNativePdfEvidenceChecker(options)` is a second port for real-size candidates. It takes the same bindings and pins as
the single-file checker, plus a `NativePdfEvidenceBudget` within `NATIVE_PDF_EVIDENCE_CEILINGS`. Each `step` takes a window
of a candidate's PDFs, each with its cited pages, and returns outcomes for the documents it settled and `remaining` for the
rest. Calling again with the remaining documents resumes. So does calling again with all of them.

- **Pages.** It checks page 1 and every cited page, never the whole document, and records the document's page count. A
  citation past the last page fails with `page-reference-out-of-range`.
- **Content receipts.** A clean render seals one `npr_content_receipts` row (viewer migration 0003). The row is keyed by
  the bytes' SHA-256 and size, the renderer version and the page set, not by candidate. A later step in any candidate
  settles a covered document, or an out-of-range citation, from that row. It does so with no byte read and no browser.
  A row that fails any check holds the document with `render-receipt-integrity`. The checks cover a missing page, other
  bytes, another renderer, a page count that disagrees with its row, a missing page 1 and non-canonical JSON. Such a row
  is never repaired or replaced. A receipt from another renderer version is not read, so the document renders again.
  These checks do not authenticate a row. A receipt is trusted because the database wrote it: anyone who can write the
  client's D1 can insert a canonical receipt with an invented page count and proofs, and it will be reused.
- **Renderer version.** `clearcase.native-pdf-pages/1;sha256:<digest>` uses the same inputs as v1, with a page program
  derived from the v1 program by five exact edits. The v1 program bytes and v1 renderer version are unchanged.
- **Sessions.** The documents still to render share one browser session. It is admitted once in `npr_pdf_sessions`
  (viewer migration 0004): one session at a time per client, at most 96 a day, and no refund. Each document gets its
  own browser context and page, closed before the next opens, with the same request interception as v1. A violation, a
  deadline or a context that does not close ends the session, and the later documents wait for the next step. A launch
  that lands after its deadline is terminated. The session ends by `started_ms + maxSessionMs` on the trusted clock, so
  the browser and its cleanup stay inside the reserved lease. An admission acknowledged too late for one document launches nothing.
- **Response memory.** The pinned SDK encodes each response body one byte per array slot before base64. The page therefore
  fetches the PDF as `input/<k>` parts of 1 MiB, and the session answers one request at a time, so only one part or one
  pinned file (at most 1.3 MB) is being encoded at once. A PDF over `maxFileBytes` (ceiling 16 MiB) fails with
  `file-budget-exceeded` before it is read, which holds publication.
- **Bounds.** `pdfEvidenceStepCost(budget)` gives one step's worst case. At the ceilings that is 259 subrequests (lookup,
  admission, every attempted read, every receipt write, launch and ASSETS), 93.5 MiB of Worker memory (three copies of
  one PDF, cached static files, one encoded response and the receipt rows) and 62 s of wall time. Receipt rows are priced
  at a fixed 41,984 bytes each for this renderer version (256 checked pages), whatever the current citation budget, and
  the lookup's overflow row is included. SQL returns no payload for a stored row over that size or with a non-ASCII
  byte, so that document holds with `render-receipt-integrity`. One absolute deadline
  covers every read, write, admission and render in the step; only browser cleanup follows it. The parent reserves this
  within Workers Paid's per-invocation limits. A kill loses only the document in flight. Its sealed receipts stand, and
  the session lease (session deadline plus cleanup plus the 60 s idle tail) delays the resume.

Not run: real Browser Rendering, `createBrowserContext` on the provider, PDF.js on a real 40-page PDF, workerd or deployed
D1. Migration 0004 is not yet in `deploy/native-alpha/runtime-migration.ts`. The tests in
`tests/hosted-foundation/native-render-check/pdf-evidence-*.test.ts` use SDK-boundary doubles over the real migrations in
SQLite, so they are not renderer acceptance.

## Parent integration hooks and module closure

1. Add the owned SQL migration to the schema assembler. Pass the **raw** DB, not
   a saved replica session; keep candidate/asset scope authorization in the parent.
2. Add BROWSER and actual ASSETS bindings to trusted runtime composition. Supply
   explicit account-allocated budgets, trusted origin/clock and immutable input.
3. Supply the reviewed inventory from `scripts/hosted-pdf-assets.ts`: exact PDF.js
   6.4.299 package digest `sha256:ae9a1328f4de3e2cf14b24d711e34299963dc64c10eab7b1afe849b79846e577`
   and reader digest `sha256:782e60af7b31feb6d7e58677e54bdbde307afb7da6dc197ac03ec0f3d8522b63`.
   The viewer's patched worker `pdfjs/pdf-viewer-worker.mjs` is pinned by `HOSTED_PDF_VIEWER_WORKER_DIGEST`
   and is never served to the render check. All 192 inventory entries must match. Copy pinned static bytes through normal
   build provenance; do not import the node:fs preparer into the Worker.
4. Install the narrowly scoped [SDK policy hook](../../../scripts/native-render-sdk-policy.ts)
   in the parent's renderer artifact build, then review the SDK's module closure
   before allowing its import at this trusted seam. The pure hook accepts only the
   exact SHA-256-pinned `common/Debug.js` and `cloudflare/utils.js` from SDK 1.4.0;
   unknown/changed/reapplied bytes and unexpected output hashes fail. Apply both
   transforms and bind their
   input/output digests and policy ID to the artifact manifest. It preserves enabled
   SDK diagnostic events and Node capture while replacing payloads with fixed event
   text; it also makes the otherwise-unused default close callback reject with a
   fixed error instead of swallowing/logging. No global console/process patching
   or audit muting is used. This is not a cleanup success shim: the checker still
   requires its own root-CDP reply and peer termination. The parent must verify both
   transformed modules in the final artifact, not just add a policy marker.
   **Hook wiring and native artifact verification remain UNRUN parent work.**
   The unchanged app guard passes because it does **not** reach this new module yet.
   The forced-root `parent-import-check.ts` fails on the absent SDK package allowance.
   A scoped Bun browser bundle includes 122 modules: SDK, debug/ms and ws's browser
   stub; it has browser-polyfilled node:buffer/path and an optional dynamic
   `fs/promises` import retained by SDK screenshot/file APIs. The SDK source also
   imports node:buffer. No such file/screenshot API is called here. Parent must
   deliberately resolve/review these host/polyfill and artifact-guard requirements;
   this worker has **not** weakened either guard, added broad node compatibility,
   or claimed the scoped Bun bundle is a deployable workerd artifact.
5. Run final **real native** synthetic acceptance on the integrated exact SHA with
   BROWSER/ASSETS/D1: valid multi-page and blank PDFs; malformed/truncated/password/
   unsupported and over-budget PDFs (including pure XFA with fallback pages while
   XFA generation stays disabled); non-PDF; wrong scope/hash; timeout/cleanup;
   real worker startup, all-page canvas completion/readbacks and exact pins;
   resource/network denial, concurrent daily reservations and failed-preview
   publication hold; persistent exact-file success reuse across readiness/sign-off/
   publish, and failure to reuse after any bound input/renderer change. Check actual
   root-CDP acknowledgement plus peer closure/idle tails and shared Free usage
   without resetting launch quotas. Exercise D1 REPLACE/UPSERT with recursive
   triggers off/on across all four tables, exact receipt no-op/reuse, forged resets
   and failed trigger rollback. Enable SDK diagnostics in acceptance and confirm
   only fixed event metadata survives provider/session error canaries.
   Keep case bytes, screenshots and credentials out of logs and committed evidence.

## What ran here

The targeted tests use clearly labelled SDK and D1 API boundary doubles plus actual
SQLite migration/trigger execution. They exercise orchestration and negative
protections, not canvas rendering, provider behaviour or D1 acceptance. Artificial
transcripts even use deliberately non-renderable synthetic input to make that
boundary unmistakable. The original 38 tests retain their names and assertions;
new regressions cover the real SDK callback with inert CDP construction, owned
close faults/acknowledgement/peer termination, XFA detection with inert PDF/Worker/
canvas APIs, all-table SQLite conflict strategies, and pinned SDK-policy source.
None are native rendering/closure evidence. Run with a private scoped config and
`--maxWorkers=1` through agent-tools receipts.
Scoped tsc checks the new module/tests against the real SDK types. The static
forced-root guard reports the missing parent package allowance without changing it.
**Real browser/provider/workerd rendering, full build and full suite: UNRUN.**

## Official references (public docs checked 25 October 2026)

- [Cloudflare Browser Run pricing](https://developers.cloudflare.com/browser-rendering/platform/pricing/): Free 10 minutes/day and three concurrent browsers.
- [Limits](https://developers.cloudflare.com/browser-rendering/limits/): Free launch rate, 60 s idle timeout, no fixed active-session lifetime, UTC daily reset.
- [Workers Puppeteer](https://developers.cloudflare.com/browser-run/puppeteer/): official BROWSER binding SDK and explicit browser.close lifecycle.
- [Session guardrails](https://developers.cloudflare.com/browser-run/features/guardrails/): allowedDomains: [] denies all outbound web requests for the session lifetime.
- [Official npm package](https://www.npmjs.com/package/@cloudflare/puppeteer/v/1.4.0): exact pinned Workers SDK; registry integrity is in bun.lock.
