# Alpha viewer contract (GRS-97)

Frozen by [GRS-97](https://linear.app/vaper/issue/GRS-97) from the evaluation in `tests/viewer-evaluation/`. The evaluation revision and per-fixture results are in [coverage-matrix.md](coverage-matrix.md). Authority: [ADR 0011](../../adr/0011-originals-and-complete-in-app-file-viewing.md), the GRS-136 readiness decision recorded in its "Originals before publication" section, and the pre-read `.orchestration/reports/CODEX-VIEWER-CANDIDATES-20261017/report.md` (ignored; local to the orchestrator checkout).

Items marked **[decided 20 October 2026][decision]** are defaults chosen because the five open questions in [handoff.md](handoff.md#open-questions-and-the-defaults-used) could not be answered during this unit; the user accepted all five on 20 October 2026. A later user decision may still change one; until then implementation owners build to the default. Section 9 lists every such default under its question number, so none depends on `handoff.md` alone.

This contract is component evidence from one local Chromium. It does not replace the hosted viewer pass in release acceptance, and it does not prove original integrity or range delivery (see [handoff.md](handoff.md#proof-still-owed-at-the-design-gate)).

## 1. Readiness states

There are two states, and they never share a code path that could let one stand in for the other.

**What the decision says.** Quoted verbatim, because the rows below are an application of it and must not be read as a restatement.

ADR 0011, "Originals before publication, 17 October", line 36:

> In [Stress-test the complete hosted-alpha plan with final workflow scenarios](https://linear.app/vaper/issue/GRS-136/stress-test-the-complete-hosted-alpha-plan-with-final-workflow) the user made one explicit, temporary exception for files that are not yet part of published results. A case's authorized users can retrieve its acknowledged originals while they are being processed. PDFs and images open in the app wherever the viewer supports them. A format that needs a manually prepared preview may show "Preview pending processing" and offer the unchanged original, for now possibly as a download.

ADR 0011, line 38:

> The exception ends at publication. Every file in published results still needs its required in-app preview, a failed preview still holds the whole update, and original and source references are preserved. The exception does not let an update publish with a download-only file, and it gives no access to a private candidate's previews or results.

The GRS-136 obligation recorded in `docs/plan/tickets/HA-grs-97.md` ("Final workflow alignment — 17 October 2026"):

> Freeze two distinct readiness states: acknowledged originals are retrievable during processing, with supported PDF/images viewable where supported and manual-conversion formats clearly Preview pending processing; published files must have their required in-app previews. The temporary retrieval/download exception must not silently reduce published-format coverage.

**What this contract adds.** The decision says that PDFs and images open "wherever the viewer supports them" and that "a format that needs a manually prepared preview may show 'Preview pending processing'". It does not say what a natively readable workbook, email, media file or ZIP shows. This contract does not narrow them to pending: **only a format whose reader cannot open the original as it is shows "Preview pending processing"** (**[decided 20 October 2026][decision]**, question 4). `descriptor.native` records, per asset, whether the family's reader opens the original byte for byte with no prepared file.

**Processing (acknowledged original).** Authorized case users can retrieve each acknowledged original while it is processed. Retrieval may be a download.

| Original | `native` | In-app view while processing |
| --- | --- | --- |
| PDF that passes the import checks (not damaged, not encrypted) | yes | Viewable in the PDF reader |
| PNG, JPEG, GIF, WebP, AVIF | yes | Viewable in the image reader |
| XLSX, XLS, CSV | yes | Viewable in the workbook reader (**[decided 20 October 2026][decision]**) |
| EML, and MSG with a body other than RTF-only | yes | Viewable in the email reader (**[decided 20 October 2026][decision]**) |
| MP4/MOV/MKV (H.264/AAC), WebM, MP3, WAV, Ogg, M4A that pass the box walk | yes | Viewable in the media reader (**[decided 20 October 2026][decision]**) |
| ZIP (stored or deflate) and plain text | yes | Viewable in the archive and text readers (**[decided 20 October 2026][decision]**) |
| DOCX, DOC | no | "Preview pending processing", with the unchanged original retrievable |
| TIFF, HEIC | no | "Preview pending processing" |
| AVI and other video the browser cannot play | no | "Preview pending processing" |
| Encrypted or damaged PDF; truncated MP4/MOV/M4A | no | "Preview pending processing" |
| MSG whose body is only RTF; TNEF; mbox, PST, OST; 7z, RAR, gzip and other containers; bytes that match no reader | no | "Preview pending processing" until the operator prepares a companion or extracts the contents (**[decided 20 October 2026][decision]**, question 4) |
| Content that sniffs as SVG or HTML, or whose bytes contradict its name | – | Refused at acknowledgement (**[decided 20 October 2026][decision]**) |

Viewable while processing says nothing about publication: a viewable original can still carry import holds (an archive with a traversal member, an EML with a TNEF attachment) that block publication of the update.

**Published.** Every file in a published results version, and every attachment, embedded message and archive member it contains, has its required in-app preview as listed in the [coverage matrix](coverage-matrix.md). Every supplied location in the update resolves. If any file, child or location fails, the whole update is held for operator repair and the last published version stays available. The processing exception gives no access to a private candidate's previews or results, and it never lets an update publish with a download-only file.

## 2. Candidate-import checks

Import runs on the trusted side (Worker or operator step). It classifies by content, never by name or declared MIME, hashes every asset, expands the closed child graph and records holds. Any hold blocks approval and publication of the whole update. `tests/viewer-evaluation/harness/import.mjs` is the reference implementation; `checks/readiness.mjs` evaluates nine candidate updates against it.

Classification is one function over the bytes (`sniff()` in `shared/formats.mjs`): magic numbers; for a ZIP the OOXML parts (`[Content_Types].xml` with `word/document.xml` is Word, with `xl/workbook.xml` a workbook, otherwise `ooxml-other`); for an OLE file the directory streams (`WordDocument`, `Workbook` or `Book`, `__properties_version1.0`). **Unknown bytes fail closed**: anything that matches no signature and is not valid UTF-8 text is kind `unknown`, family `unknown`, and held. The one place a name is consulted is `.csv`, on bytes already known to be text. Archives and email recurse through one function, one depth counter and one expansion budget.

| Hold code | Raised when | Fixture evidence |
| --- | --- | --- |
| `content-type-mismatch` | The file's extension names an image or PDF type that its bytes are not | `image/svg-masquerade.png`, `image/html-masquerade.jpg` |
| `active-content-not-accepted` | Bytes sniff as SVG or HTML | as above |
| `pdf-damaged` | No `startxref`/`%%EOF` trailer, even if pdf.js recovers pages | `pdf/truncated.pdf` |
| `pdf-encrypted-needs-decrypted-rendition` | The PDF names `/Encrypt` followed by any delimiter (a reference or an inline `<<…>>`) and no decrypted `pdf` rendition is linked | held: `pdf/encrypted-user-password.pdf`, `pdf/encrypted-inline-dict.pdf`; cleared by a linked rendition: `pdf/encrypted-with-rendition.pdf` (candidate H) |
| `media-damaged` | ISO BMFF top-level boxes do not tile the file exactly (a cut MP4, MOV or M4A); Chrome alone plays such a file as if complete | `media/mp4-truncated.mp4` |
| `prepared-rendition-missing` | The format has no native reader (TIFF, HEIC, AVI) and no prepared rendition is linked | `image/tiff-lzw.tif` (candidate E) |
| `sheet-visual-content-needs-supplement` | An XLSX has chart or drawing parts and no prepared supplement is linked | `sheet/chart.xlsx` (satisfied by its supplement) |
| `rtf-only-body-needs-companion` | An MSG body exists only as compressed RTF and no `body-text` companion is linked | held: `email/outlook-rtf-only.msg`; cleared by a linked companion: `email/outlook-rtf-only-with-companion.msg` (candidate I) |
| `tnef-needs-companion` | An attachment is `application/ms-tnef` (winmail.dat). **Unevaluated**: no companion fixture exists, so whether a companion can clear it is not shown | `email/hostile.eml` (held only) |
| `malformed-mime-part` | A base64 part contains characters outside the alphabet | `email/hostile.eml` |
| `bulk-mailbox-needs-manual-extraction` | The bytes are an mbox or a PST/OST store (`!BDN`), not one message, at the top level, inside a ZIP or attached to an EML | `email/gmail-takeout.mbox`; `unknown/synthetic-mailbox.pst`, `unknown/synthetic-cache.ost` at all three levels |
| `unsupported-container-needs-manual-extraction` | The bytes are 7z, RAR, gzip (including `.tgz`), bzip2, xz, zstd or tar | `unknown/synthetic-archive.7z`, `.rar`, `synthetic-takeout.tgz` at all three levels |
| `unrecognised-format` | The bytes match no signature and are not valid text (UTF-8, no NUL, almost no control characters) | `unknown/opaque.bin` at all three levels |
| `unsupported-office-format` | A ZIP-based package that is not Word or a workbook, or an OLE file that is not Word 97, Excel 97 or an Outlook message | `rename/pptx-shaped.zip` |
| `rendition-page-count-mismatch` | A TIFF's prepared page images are not exactly pages 1 to N, N counted from the file's own image directories | `image/tiff-gappy.tif` (pages 1 and 3 of 3) |
| `nesting-limit` | A container at depth 3 has contents (depth counts every ZIP and message above an asset; one counter for both) (**[decided 20 October 2026][decision]**) | `archive/nest-zip-6.zip`, `archive/nest-eml-zip-chain.zip` |
| `archive-unsafe-path` | A member path is absolute, has a drive letter or backslash, or contains `..` | `archive/traversal.zip` |
| `archive-symlink` | A member is a symbolic link | `archive/traversal.zip` |
| `archive-encrypted` | General-purpose bit 0 is set | `archive/encrypted-flag.zip` |
| `archive-unsupported-method-N` | Compression method is not stored (0) or deflate (8) | `archive/unsupported-method.zip` |
| `archive-crc-mismatch` | The extracted bytes do not match the recorded CRC-32 | `archive/corrupt-crc.zip` |
| `archive-declared-size-over-limit` | A member declares more than 64 MiB (**[decided 20 October 2026][decision]**) | `archive/bomb-256mib.zip` |
| `archive-expansion-limit-exceeded` | Inflation passes 64 MiB whatever the header said | `archive/bomb-lying-size.zip` |
| `archive-total-expansion-limit` | The bytes extracted from the whole tree (every ZIP member and email attachment under one original) pass 512 MiB (**[decided 20 October 2026][decision]**); the evaluation runs the same code with a 1,000,000-byte cap | `archive/budget-mixed.zip` (each container under the cap, the tree over it) |
| `archive-too-many-entries`, `archive-zip64-unsupported`, `archive-split-unsupported` | More than 10,000 members in one archive or in the whole tree, ZIP64 or split archives (**[decided 20 October 2026][decision]**) | none (limit only) |
| `required-preview-missing`, `preview-failed:*`, `child-preview-failed:*` | The reader for the file or a child does not report ready, or the preview asset itself carries a hold | candidates B and E; `preview-failed:*` with no import hold on the file: candidate F (`image/png-corrupt-body.png`) |
| a resolution code from section 4 | A supplied location does not resolve | candidates C, D |

Duplicate member or attachment names are not a hold: each is kept by position. Citing one by a duplicated name is a hold (`ambiguous-entry`, `ambiguous-attachment`).

## 3. Per-format adapter descriptor

Every reader receives one schema-validated descriptor per asset and the bytes the broker fetched for it. Readers never receive storage credentials, URLs chosen by the document, or authority to fetch other assets.

```js
{
  schema: 'clearcase.viewer-descriptor/1',
  assetId, name, size, sha256,          // the broker refuses bytes whose SHA-256 differs
  family: 'pdf' | 'image' | 'word' | 'sheet' | 'email' | 'media' | 'archive' | 'text' | 'unknown',
  mime, variant,                        // from content sniffing, never from the name; variant may be null
  native: boolean,                      // the reader opens this original as it is (section 1)
  pages: integer | null,                // TIFF image count read from the file itself
  role: 'original' | 'rendition' | 'supplement' | 'child',
  original: { assetId, sha256 } | null, // set exactly when role is rendition or supplement
  rendition: { version, page: integer | null, mapping: { kind: 'none' } | { kind: 'verified', pages: { [originalPage]: renditionPage } } } | null, // same rule
  renditions: [{ assetId, kind: 'pdf' | 'page-image' | 'ocr-text' | 'captions' | 'body-text', version, page, sha256, role }],
  children: [
    { kind: 'attachment', key, assetId, name | null, mime, declaredMime | null, sha256, contentId | null, inline, embeddedMessage },
    { kind: 'member', key, path, directory, assetId | null, mime | null, family | null, sha256 | null, size | null, duplicateName, problems: [] },
  ],                                    // a member without assetId has directory true or a non-empty problems list, and null mime, family, sha256 and size
  parent: { assetId, key } | null,      // set exactly when role is child
  visualParts: [],                      // workbook chart/drawing parts that need a supplement
  limits: { zip: { maxEntries, maxEntryBytes, maxTotalBytes, maxDepth } },
  holds: [{ code, detail }],
}
```

**One validator, two callers.** `shared/descriptor.mjs` returns the path of every field that is missing, null where null is not allowed, retyped, outside its enum, or inconsistent with `role` (only renditions and supplements carry `original` and `rendition`; only children carry `parent`). The shell calls it before it creates a frame, and every reader calls it again on its own descriptor and on each extra it is handed (`error: invalid-descriptor`); `resolvePaged` calls it a third time before it reads `role`. A missing or retyped field therefore fails closed in both places, and no citation resolves from a descriptor that is not exactly the schema. `checks/descriptor.mjs` mutates every field of eleven representative descriptors (delete, null, retype, arrays at elements 0 and 1; 67 to 141 mutations each) and requires both the shell and the reader to refuse every one; it also removes, nulls and retypes `role` on an unmapped rendition and requires that `original-page 2` never resolves. `containment.mjs` keeps its original 14 shell mutations. The shell separately refuses `family: 'unknown'` (no reader), so unknown bytes can only ever be held, never opened. No `rendition.mapping` means original-page citations need repair; no trusted child entry means the attachment or member does not open. Content that matches no reader gets `family: 'unknown'`: readiness holds the update with `child-preview-failed:no-reader` as well as the import hold.

Prepared page images are keyed on `rendition.page` in their own descriptor, never by position: each must name this original, page numbers are unique, and original page N with no image is `unmapped-original-location`, not the next image.

## 4. Targets and resolution

Target union, one per citation:

| Target | Applies to | Resolves when |
| --- | --- | --- |
| `{ kind: 'file' }` | every family | always; labelled "File-level reference: no precise location supplied" |
| `{ kind: 'original-page', page }` | PDF originals, prepared page images, renditions with a verified mapping | page is an integer inside the original; on a rendition only through `mapping.kind === 'verified'` |
| `{ kind: 'page-label', label }` | PDF | exactly one page carries that label |
| `{ kind: 'rendition-page', version, page }` | prepared PDFs and page-image sets | version equals the current rendition version and the page exists; labelled as generated pagination |
| `{ kind: 'cell', sheet, ref }` | workbooks, CSV | exact sheet name; `ref` is a cell or range inside A1:XFD1048576 |
| `{ kind: 'message' }`, `{ kind: 'attachment', key }` or `{ kind: 'attachment', name }` | EML, MSG | the key exists, or the name is unique |
| `{ kind: 'media-time', seconds }` | audio, video | 0 ≤ seconds ≤ duration |
| `{ kind: 'archive-entry', ordinal }` or `{ kind: 'archive-entry', path }` | ZIP | the ordinal exists, or the path is unique |

A reader answers `{ ok: true, label }` or `{ ok: false, code, detail, repair: true }`. Codes: `invalid-target`, `ambiguous-label`, `ambiguous-attachment`, `ambiguous-entry`, `stale-rendition`, `not-a-rendition`, `unmapped-original-location`, `unsupported-target`, `navigation-failed`, `navigation-timeout`. A refused target never moves the view: the evaluation asserts the visible page, cell, attachment, entry or time is unchanged after each refusal. A cell outside the used range but inside the grid resolves and is labelled empty; a sheet name differing only in case does not resolve.

## 5. Protected shell and broker

The shell is the only party that holds the session. Readers run in a separate document with an opaque origin.

1. The shell fetches the descriptor and bytes with the session, checks the SHA-256, then creates a frame with `sandbox="allow-scripts"` (no `allow-same-origin`, forms, popups or top navigation), `referrerpolicy="no-referrer"` and every permission policy feature off.
2. The frame URL carries a generation number and a 128-bit nonce in its fragment.
3. The reader posts `hello` with its generation to its parent. The shell accepts it only from the current frame's `contentWindow`, once, and replies with a `MessagePort`.
4. The reader must claim the port with the nonce from its own URL. The shell sends the bytes only after a correct claim, and only if the frame has loaded exactly once. A wrong claim, or a second `load` event (the frame navigated), kills the generation.
5. Contained files open from the trusted descriptor's `children` by key. A reader can ask for a key; it cannot supply an asset id or bytes.
6. Escape in a reader returns focus to the shell's close control.

Reader CSP, served as a header with the frame document: `sandbox allow-scripts; default-src 'none'; script-src <origin>/r/ <origin>/vendor/pdfjs/; style-src <origin>/r/ <origin>/vendor/ ['unsafe-inline' for word, sheet and email]; img-src blob: data:; media-src blob:; font-src <origin>/vendor/pdfjs/ data:; connect-src 'none' [PDF only: the static CMap and standard-font paths]; worker-src 'none'; frame-src 'none' [email: 'self' for the sandboxed srcdoc body]; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors <origin>`. The hosted owner moves `<origin>` to a separate credential-free viewer site; the static PDF resources need `Access-Control-Allow-Origin: *` and no cookies. Docx-preview and Tabulator inject styles at run time, which is why those readers need `'unsafe-inline'` for styles (never for scripts).

The pdf.js reader keeps the incumbent's settings: scripting, XFA, forms and WASM off, `isEvalSupported: false`, external links rendered inert, main-thread worker. The email body is sanitised by DOMPurify inside the reader, then shown in a nested `sandbox=""` srcdoc frame whose own CSP allows only `data:` images and inline styles. CID images become `data:` URLs from the matching attachment; every other image source and every link target is removed and counted.

## 6. Limits

Stress tiers below are measurements at the starting tiers, not limits the product enforces (**[decided 20 October 2026][decision]**): 1,000 PDF pages, 20 and 100 MP images, 100k and 1m populated cells, 1,000 archive members. ZIP limits are 10,000 members, 64 MiB per member, 512 MiB total and nesting depth 3 (**[decided 20 October 2026][decision]**). Measured times are in the [coverage matrix](coverage-matrix.md#scale).

## 7. File reservations for the implementation owners

Production paths do not exist yet; these are the reservations to request in the approved implementation plan. The owner of each row also owns its tests under the matching `tests/` path.

| Owner | Scope | Reserved paths |
| --- | --- | --- |
| [GRS-120](https://linear.app/vaper/issue/GRS-120) | Protected shell, broker, descriptor schema, readiness states, PDF and image readers, plain-text reader | `src/lib/viewer/shell/**`, `src/lib/viewer/broker/**`, `src/lib/viewer/descriptor/**`, `src/lib/viewer/readers/{pdf,image,text}/**`, `src/routes/v/**` (viewer site), `static/viewer/**`, `tests/viewer/shell/**` |
| [GRS-121](https://linear.app/vaper/issue/GRS-121) | Workbook reader, docx-preview companion (if kept), prepared Word/Excel rendition and supplement records | `src/lib/viewer/readers/{sheet,word}/**`, `src/lib/viewer/renditions/office/**`, `tests/viewer/office/**` |
| [GRS-122](https://linear.app/vaper/issue/GRS-122) | EML/MSG reader, sanitiser, attachment graph, bulk-mailbox extraction record | `src/lib/viewer/readers/email/**`, `src/lib/viewer/import/email/**`, `tests/viewer/email/**` |
| [GRS-123](https://linear.app/vaper/issue/GRS-123) | Media reader, prepared media renditions, ZIP reader and archive import | `src/lib/viewer/readers/{media,archive}/**`, `src/lib/viewer/import/archive/**`, `tests/viewer/media-archive/**` |

Shared files (`package.json`, `bun.lock`, `src/lib/viewer/descriptor/**` once GRS-120 lands) change only through their owner. GRS-112 pre-adds the dependencies in [handoff.md](handoff.md#dependencies-for-grs-112-to-pre-add).

## 8. Integration checks a later owner must pass

Each check is a port of a harness check to the hosted shell, run at the owner's head under `gate:hosted` once it exists. "Same as" names the evaluation check in `tests/viewer-evaluation/harness/checks/`.

All owners:

1. Opaque-origin reader: `self.origin === 'null'`; `document.cookie` and `localStorage` throw; `fetch` of any case asset (with `credentials: 'include'`) is refused and no authorized asset request reaches the server; top navigation throws; `window.open` returns null. Same as `containment.mjs`.
2. Broker: a forged `hello`, a wrong-nonce claim and a navigation between port hand-off and claim each yield zero bytes, the last two kill the generation. A descriptor hash mismatch stops before a frame exists. Same as `containment.mjs`.
3. Every refused target leaves the view unchanged and returns the code in section 4. Same as `rejects()` in `checks/common.mjs`.
4. Keyboard: Tab from the shell enters the reader; Escape returns focus to the shell. Layout fits 1440×900, 1024×768 and 390×844 with no horizontal page scroll and touch targets of at least 24 CSS px.
5. A session-level monitor records zero egress, dialogs, popups and top navigations for the whole family run.
6. Readiness: candidates A to I in `readiness.mjs` produce the same ready/held outcome and reason codes against the hosted import and publication path, and REVIEW.md's "Failed preview does not hold publication" probe passes. Candidate F is that probe's evaluation fixture: a file with no import hold whose reader fails (`image/png-corrupt-body.png`, `preview-failed:decode-failed`).
7. Import classes: every check in `importclass.mjs` passes against the hosted import: unknown, mailbox and container bytes held at the top level, inside a ZIP and on an EML; family from bytes (renamed fixtures); one depth counter and one budget across ZIP and email; page images by `rendition.page`; a Gmail forwarded-as-attachment message two levels deep.
8. Descriptor: `descriptor.mjs` passes against the hosted shell and every hosted reader.

GRS-120: `pdf.mjs` and `image.mjs` checks, including page labels, invalid and ambiguous targets, find, zoom, PageDown, rotated and mixed page sizes, attributes inherited through the page tree and `/Contents` arrays, JavaScript detected and not run, external links inert, CMap fetches without credentials, the 1,000-page tier; EXIF orientation, alpha, animation frames, a 100 MP image (Chrome rejects `decode()` for it although it loads; fall back to load plus `createImageBitmap`, never treat that rejection alone as a failure), refusal of SVG/HTML masquerades and of TIFF/HEIC without renditions, prepared page images by original page.

GRS-121: `sheet.mjs` and `word.mjs` checks: all tabs including hidden and very hidden, hidden rows/columns labelled, exact stored and displayed values, formula without a stored result shown as formula plus "value unavailable" (SheetJS CE parses such a cell as `{ t: 'z', v: 0 }`, so the adapter keys on `t === 'z'` with a formula present, never on `v`), comments, 1904 dates, raw CSV, HTML-like text inert, search across all sheets including hidden content, keyboard tabs and grid; prepared PDF carries every content token, is tagged, follows the source's breaks, refuses stale versions and unmapped original pages, and accepts a verified mapping. An office-generated supplement must never be the source of a formula result (it recalculated here; see the matrix).

GRS-122: `email.mjs` checks for both provider shapes, MSG and EML: headers in original order, encoded-word and folded subjects, Latin-1 bodies, HTML and plain alternatives, CID images bound as `data:`, remote content removed with zero egress, attachment hashes equal to the import graph, recursive nested EML/MSG, duplicate names by position, RTF-only and TNEF holds, mbox refusal. Repeat on owner-created real Outlook and Gmail exports before release (see handoff).

GRS-123: `media.mjs` and `archive.mjs` checks: decode, seek accuracy by frame colour at start/middle/end, captions, refusal outside the duration, explicit failure for AVI, a truncated MP4 held at import by the box walk (the reader alone shows it as complete), the prepared H.264/AAC rendition path; every member listed in order with its status, recursive dispatch to each family's reader, duplicates by position, every hostile archive held with its reason, the 1,000-member tier.

## 9. Defaults decided 20 October 2026

Every default below was chosen because the question could not be put to the user during this unit. The user accepted all of them (**[decided 20 October 2026][decision]**); implementation owners build to the default. The question text is in [handoff.md](handoff.md#open-questions-and-the-defaults-used).

| # | Question | Default built into this contract | Where it appears |
| --- | --- | --- | --- |
| 1 | Accepted codecs, image formats and archive methods | Images PNG, JPEG, GIF, WebP, AVIF native; TIFF (including BigTIFF) and HEIC through prepared page images. Media: MP4/MOV/MKV with H.264/AAC, WebM VP9/Opus, MP3, WAV, Ogg Opus and M4A native; AVI, HEVC and other video through a prepared H.264/AAC rendition. ZIP stored or deflate, unencrypted, single volume, no ZIP64, nesting depth 3. **Mailbox stores and other containers are not accepted as one file**: mbox, PST and OST need the operator to extract EML files and record the mailbox hash and offsets; 7z, RAR, gzip, bzip2, xz, zstd and tar are held for manual extraction; bytes that match no reader are held | Sections 1, 2 (`bulk-mailbox-…`, `unsupported-container-…`, `unrecognised-format`, `archive-*`) and 6 |
| 2 | Initial POC limits | The measured tiers (1,000 PDF pages, 20 and 100 MP images, 100k and 1m cells, 1,000 archive members); ZIP members 64 MiB, 512 MiB for the whole tree, 10,000 members for the whole tree, nesting depth 3. No latency or memory budget | Sections 2 (`nesting-limit`, `archive-*`) and 6 |
| 3 | Reference application, fonts and presentation of tracked changes, hidden content, chart-only data, stale caches and embedded objects | LibreOffice 26.2 with `ExportNotesInMargin=true` as the operator reference; comments in the margin; tracked changes as exported markup; hidden content and comments shown from the original in the grid; stored formula results shown as stored, never recalculated, and a missing one as "value unavailable"; an office-rendered supplement is visual-only | Sections 2 (`sheet-visual-content-needs-supplement`) and 8 (GRS-121) |
| 4 | Who prepares and reviews OCR, RTF companions, captions and location maps, and the turnaround shown as "Preview pending processing" | The operator running the processing recipe prepares and reviews them; there is no turnaround target; any unmappable supplied reference holds the whole update. The processing-state list in section 1 (natively readable originals viewable; only formats that need a prepared preview pending; SVG/HTML and name-contradicting bytes refused at acknowledgement) is also this question's default | Sections 1 and 2 (`rtf-only-body-needs-companion`, `tnef-needs-companion`, `prepared-rendition-missing`) |
| 5 | SheetJS CE cadence and operator licences | SheetJS CE 0.20.3 from the official CDN, pinned by integrity, with an update lane owned by GRS-112; LibreOffice (MPL) and a GPL FFmpeg build on the operator workstation only, notices kept; no commercial or external viewer or conversion service | Section 7 (shared files) and the dependency table in handoff.md |

[decision]: https://linear.app/vaper/issue/GRS-27#comment-629983a8
