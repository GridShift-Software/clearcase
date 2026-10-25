# Native protected original and image viewer (PDF, images)

Status: PREPARED, UNVERIFIED. Source and unit tests exist at the commit named in the central report. No browser, workerd, real R2/D1, real identity or composed deployment has run. This is not a gate, native or hosted PASS, and no acceptance checkpoint is claimed. Authority: [ADR 0011](../adr/0011-originals-and-complete-in-app-file-viewing.md), including "Originals before publication", and the `AssetsAccess` contract (`src/lib/server/runtime/contracts.ts`).

## What a signed-in user gets

| Route | Method | Answer |
| --- | --- | --- |
| `/cases/[caseId]/originals/[assetId]` | GET, HEAD | The original's bytes: 200, 206 (one range), 416, 410 (missing or changed), 404 (no authority, no such asset, malformed id), 503 (port unavailable, audit failed) |
| `/cases/[caseId]/originals/[assetId]?download=1` | GET, HEAD | Always an attachment |
| `/cases/[caseId]/originals/[assetId]/view` | page | The in-app viewer: PDF reader with page navigation, zoom and notes; image; or the unchanged original as a download; or "no longer available / failed its integrity check" |
| `/cases/[caseId]/originals/[assetId]/notes` | GET, POST, DELETE | Page notes on the original (JSON, same origin) |
| `/cases/[caseId]/v/[version]/assets/[assetId]` | GET, HEAD | A derived preview of that exact results version, same delivery rules |

Authority is `read-original` (originals, case-level: a published version is not needed) or `read-preview` (previews: the exact version must be published and not withdrawn, re-checked after the read). Both come from the injected `AssetsAccess`; the routes keep no grant, key or session state. A refusal never carries body bytes. No URL holds an object key, a storage id, a session id or a hash.

## Inline versus download

Bytes are shown inline only when all hold: no `?download=1`; the declared type's serve policy is inline (PDF, JPEG, PNG, GIF, WebP); the request is a script `fetch` (`Sec-Fetch-Dest: empty`) or, for images, an `<img>` (`image`); and the first KiB of the bytes sniffs as that family. Anything else, including a navigation, frame, embed, object, no destination header, a PDF-named HTML file, or DOCX/TIFF/anything download-only, is the unchanged original as an attachment. An inline response carries `Content-Security-Policy: sandbox; default-src 'none'; frame-ancestors 'none'`, `nosniff`, `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin`, `Vary: Range, Sec-Fetch-Dest`. A PDF is therefore never rendered by the browser's own viewer on the application origin; only the native reader draws it.

Ranges, `If-Range` (exact current strong ETag keeps the range; anything else gets the whole object) and `ETag` come from `AssetsAccess.get`, cut from the SHA-256-verified bytes. The route adds only the presentation headers. The content sniff costs one extra audited, verified read (see handoff 5).

## Page notes

A note is a person's remark on one page of one original, kept in user work (`AsyncUserWork` register store `original-page-notes`), never in the browser. Each stores the original's SHA-256 at the time; a note whose original has since changed is listed as not current. Writes need a same-origin JSON body of at most 8 KiB, a page 1..100000 and 1..2000 well-formed characters, an `operationId` (a retry repeats), and an expected version to delete. The original must be readable by the caller first (404 otherwise, nothing written). User work not connected answers 503, never an empty list.

## Parent handoffs (nothing below is done here)

1. **Static assets.** Copy `node_modules/pdfjs-dist/build/pdf.min.mjs`, `build/pdf.worker.min.mjs`, `standard_fonts/`, `cmaps/`, `iccs/` and `src/lib/viewer/hosted/static/pdf-reader.mjs` into the deployed static directory as `/pdfjs/`. Do not copy the pdf.js scripting sandbox or wasm (the reader sets `useWasm: false`, `enableScripting: false`). The pdf.js package stays outside the hosted import allowlist; only this static adapter loads it.
2. **CSP for `/cases/*/originals/*/view`.** `script-src 'self'`; `worker-src 'self'`; `connect-src 'self'`; `img-src 'self' blob: data:`; `style-src 'self' 'unsafe-inline'` if the layout needs it; `object-src 'none'`; `frame-ancestors 'none'`; `base-uri 'none'`. The hooks, layout and CSP are shared files.
3. **Links.** The case overview (`cases/[caseId]/+page.svelte` and `+page.server.ts`, owned elsewhere) still links `/originals/[assetId]`, which is now the byte route. It should link `/originals/[assetId]/view` and keep the byte route for the download link. `AssetsAccess.links` already returns `viewerHref: null`; the composer can pass `viewerRoute` (`createCloudResults`) to offer `/cases/<id>/originals/<asset>/view`.
4. **Root vitest include.** Add `tests/hosted-smoke/native-viewer/**/*.test.ts` (this directory carries its own `vitest.config.ts`, and note the Vitest include list replaces the root list).
5. **Content class from the access port.** The sniff probe should become a stored content class on `AssetMetadata` set at acknowledgement (a shared runtime change). Until then the route reads the first KiB through `AssetsAccess.get`, so every inline view records two `asset.read-original` events and verifies the object twice; objects over the buffered budget are refused as before.
6. **Notes in the shared model.** `NoteTarget` has no original target, so page notes use a register store. If the glossary owner wants them as Notes, `NoteTarget` needs an `original` kind (shared contract).
7. **Composition.** `locals.assets` and `locals.userWork` must be the real cloud adapters. Null ports answer 503 on every route here; there is no test login, default allow or in-memory fallback in these files.

## Not covered

No text layer, search, selection, thumbnails, print, rotation, page-citation navigation (`#page=`) or annotation drawing: the reader draws a page to a canvas. No image zoom. No Word, spreadsheet, email, media or archive viewing (download-only here). Streaming of objects over the buffered budget is not offered. Real R2 range and conditional behaviour, workerd, Chromium rendering, real revocation latency and audit durability are UNRUN.

## Evidence

`tests/hosted-smoke/native-viewer/` (74 unit tests): the real `createCloudResults` assets and storage adapters over the storage SQLite/in-memory doubles, the real route modules, synthetic bytes only. Run alone with `bunx vitest run --config tests/hosted-smoke/native-viewer/vitest.config.ts`.
