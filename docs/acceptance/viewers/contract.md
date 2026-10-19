# Alpha viewer contract (GRS-97)

Frozen by [GRS-97](https://linear.app/vaper/issue/GRS-97) from the evaluation in `tests/viewer-evaluation/`. The evaluation revision and per-fixture results are in [coverage-matrix.md](coverage-matrix.md). Authority: [ADR 0011](../../adr/0011-originals-and-complete-in-app-file-viewing.md), the GRS-136 readiness decision recorded in its "Originals before publication" section, and the pre-read `.orchestration/reports/CODEX-VIEWER-CANDIDATES-20261017/report.md` (ignored; local to the orchestrator checkout).

Items marked **assumed, pending user answer** are defaults chosen because the five open questions in [handoff.md](handoff.md#open-questions-and-the-defaults-used) could not be answered during this unit. Each one may be changed by the user; until then implementation owners build to the default.

This contract is component evidence from one local Chromium. It does not replace the hosted viewer pass in release acceptance, and it does not prove original integrity or range delivery (see [handoff.md](handoff.md#proof-still-owed-at-the-design-gate)).

## 1. Readiness states

There are two states, and they never share a code path that could let one stand in for the other.

**Processing (acknowledged original).** Authorized case users can retrieve each acknowledged original while it is processed. Retrieval may be a download.

| Original | In-app view while processing |
| --- | --- |
| PDF that passes the import checks (not damaged, not encrypted) | Viewable in the PDF reader |
| PNG, JPEG, GIF, WebP, AVIF | Viewable in the image reader |
| Everything else, including TIFF, HEIC, DOCX, DOC, XLSX, XLS, CSV, EML, MSG, media and ZIP | "Preview pending processing", with the unchanged original retrievable |
| Content that sniffs as SVG or HTML, or whose bytes contradict its name | Refused at acknowledgement (**assumed, pending user answer**) |

Workbooks, email and archives passed the browser readers here without any manual conversion, so they could open while processing too. The decision names only PDF and images, so this contract keeps them pending; widening the list is a user decision, not an implementation choice.

**Published.** Every file in a published results version, and every attachment, embedded message and archive member it contains, has its required in-app preview as listed in the [coverage matrix](coverage-matrix.md). Every supplied location in the update resolves. If any file, child or location fails, the whole update is held for operator repair and the last published version stays available. The processing exception gives no access to a private candidate's previews or results, and it never lets an update publish with a download-only file.

## 2. Candidate-import checks

Import runs on the trusted side (Worker or operator step). It classifies by content, never by name or declared MIME, hashes every asset, expands the closed child graph and records holds. Any hold blocks approval and publication of the whole update. `tests/viewer-evaluation/harness/import.mjs` is the reference implementation; `checks/readiness.mjs` evaluates five candidate updates against it.

| Hold code | Raised when | Fixture evidence |
| --- | --- | --- |
| `content-type-mismatch` | The file's extension names an image or PDF type that its bytes are not | `image/svg-masquerade.png`, `image/html-masquerade.jpg` |
| `active-content-not-accepted` | Bytes sniff as SVG or HTML | as above |
| `pdf-damaged` | No `startxref`/`%%EOF` trailer, even if pdf.js recovers pages | `pdf/truncated.pdf` |
| `pdf-encrypted-needs-decrypted-rendition` | The PDF names `/Encrypt` followed by any delimiter (a reference or an inline `<<…>>`) | `pdf/encrypted-user-password.pdf`, `pdf/encrypted-inline-dict.pdf` |
| `media-damaged` | ISO BMFF top-level boxes do not tile the file exactly (a cut MP4, MOV or M4A); Chrome alone plays such a file as if complete | `media/mp4-truncated.mp4` |
| `prepared-rendition-missing` | The format has no native reader (TIFF, HEIC, AVI) and no prepared rendition is linked | `image/tiff-lzw.tif` (candidate E) |
| `sheet-visual-content-needs-supplement` | An XLSX has chart or drawing parts and no prepared supplement is linked | `sheet/chart.xlsx` (satisfied by its supplement) |
| `rtf-only-body-needs-companion` | An MSG body exists only as compressed RTF | `email/outlook-rtf-only.msg` |
| `tnef-needs-companion` | An attachment is `application/ms-tnef` (winmail.dat) | `email/hostile.eml` |
| `malformed-mime-part` | A base64 part contains characters outside the alphabet | `email/hostile.eml` |
| `bulk-mailbox-needs-manual-extraction` | The file is an mbox (or PST/OST) mailbox, not one message | `email/gmail-takeout.mbox` |
| `nesting-limit` | Messages or archives nest deeper than 3 levels (**assumed, pending user answer**) | none (limit only) |
| `archive-unsafe-path` | A member path is absolute, has a drive letter or backslash, or contains `..` | `archive/traversal.zip` |
| `archive-symlink` | A member is a symbolic link | `archive/traversal.zip` |
| `archive-encrypted` | General-purpose bit 0 is set | `archive/encrypted-flag.zip` |
| `archive-unsupported-method-N` | Compression method is not stored (0) or deflate (8) | `archive/unsupported-method.zip` |
| `archive-crc-mismatch` | The extracted bytes do not match the recorded CRC-32 | `archive/corrupt-crc.zip` |
| `archive-declared-size-over-limit` | A member declares more than 64 MiB (**assumed, pending user answer**) | `archive/bomb-256mib.zip` |
| `archive-expansion-limit-exceeded` | Inflation passes 64 MiB whatever the header said | `archive/bomb-lying-size.zip` |
| `archive-total-expansion-limit` | Total expansion passes 512 MiB (**assumed, pending user answer**) | none (limit only) |
| `archive-too-many-entries`, `archive-zip64-unsupported`, `archive-split-unsupported` | More than 10,000 members, ZIP64 or split archives (**assumed, pending user answer**) | none (limit only) |
| `required-preview-missing`, `preview-failed:*`, `child-preview-failed:*` | The reader for the file or a child does not report ready | candidates B, E |
| a resolution code from section 4 | A supplied location does not resolve | candidates C, D |

Duplicate member or attachment names are not a hold: each is kept by position. Citing one by a duplicated name is a hold (`ambiguous-entry`, `ambiguous-attachment`).

## 3. Per-format adapter descriptor

Every reader receives one schema-validated descriptor per asset and the bytes the broker fetched for it. Readers never receive storage credentials, URLs chosen by the document, or authority to fetch other assets.

```js
{
  schema: 'clearcase.viewer-descriptor/1',
  assetId, name, size, sha256,          // the broker refuses bytes whose SHA-256 differs
  family: 'pdf' | 'image' | 'word' | 'sheet' | 'email' | 'media' | 'archive' | 'text',
  mime, variant,                        // from content sniffing, never from the name
  role: 'original' | 'rendition' | 'supplement' | 'child',
  original: { assetId, sha256 } | null, // for renditions and supplements
  rendition: { version, page, mapping: { kind: 'none' } | { kind: 'verified', pages: { [originalPage]: renditionPage } } } | null,
  renditions: [{ assetId, kind: 'pdf' | 'page-image' | 'ocr-text' | 'captions', version, page, sha256, role }],
  children: [{ key, assetId, name | path, mime, sha256, problems, duplicateName, contentId, embeddedMessage }],
  parent: { assetId, key } | null,
  visualParts: [],                      // workbook chart/drawing parts that need a supplement
  limits: { zip: { maxEntries, maxEntryBytes, maxTotalBytes, maxDepth } },
  holds: [{ code, detail }],
}
```

A missing or retyped field fails closed. The shell refuses to create a frame when `schema`, `assetId`, `sha256` (64 lower-case hex), `family`, `children` or `holds` is missing, null or of the wrong type, or when the bytes' SHA-256 differs (`containment.mjs` probes 14 such mutations). No `rendition.mapping` means original-page citations need repair; no trusted child entry means the attachment or member does not open. Content that matches no reader gets `family: 'unknown'`: the shell refuses it, and readiness holds the update with `child-preview-failed:no-reader`.

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

Stress tiers below are measurements at the proposed starting tiers, not agreed limits (**assumed, pending user answer**): 1,000 PDF pages, 20 and 100 MP images, 100k and 1m populated cells, 1,000 archive members. ZIP limits are 10,000 members, 64 MiB per member, 512 MiB total and nesting depth 3 (**assumed, pending user answer**). Measured times are in the [coverage matrix](coverage-matrix.md#scale).

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
6. Readiness: candidates A to E in `readiness.mjs` produce the same ready/held outcome and reason codes against the hosted import and publication path, and REVIEW.md's "Failed preview does not hold publication" probe passes.

GRS-120: `pdf.mjs` and `image.mjs` checks, including page labels, invalid and ambiguous targets, find, zoom, PageDown, rotated and mixed page sizes, attributes inherited through the page tree and `/Contents` arrays, JavaScript detected and not run, external links inert, CMap fetches without credentials, the 1,000-page tier; EXIF orientation, alpha, animation frames, a 100 MP image (Chrome rejects `decode()` for it although it loads; fall back to load plus `createImageBitmap`, never treat that rejection alone as a failure), refusal of SVG/HTML masquerades and of TIFF/HEIC without renditions, prepared page images by original page.

GRS-121: `sheet.mjs` and `word.mjs` checks: all tabs including hidden and very hidden, hidden rows/columns labelled, exact stored and displayed values, formula without a stored result shown as formula plus "value unavailable" (SheetJS CE parses such a cell as `{ t: 'z', v: 0 }`, so the adapter keys on `t === 'z'` with a formula present, never on `v`), comments, 1904 dates, raw CSV, HTML-like text inert, search across all sheets including hidden content, keyboard tabs and grid; prepared PDF carries every content token, is tagged, follows the source's breaks, refuses stale versions and unmapped original pages, and accepts a verified mapping. An office-generated supplement must never be the source of a formula result (it recalculated here; see the matrix).

GRS-122: `email.mjs` checks for both provider shapes, MSG and EML: headers in original order, encoded-word and folded subjects, Latin-1 bodies, HTML and plain alternatives, CID images bound as `data:`, remote content removed with zero egress, attachment hashes equal to the import graph, recursive nested EML/MSG, duplicate names by position, RTF-only and TNEF holds, mbox refusal. Repeat on owner-created real Outlook and Gmail exports before release (see handoff).

GRS-123: `media.mjs` and `archive.mjs` checks: decode, seek accuracy by frame colour at start/middle/end, captions, refusal outside the duration, explicit failure for AVI, a truncated MP4 held at import by the box walk (the reader alone shows it as complete), the prepared H.264/AAC rendition path; every member listed in order with its status, recursive dispatch to each family's reader, duplicates by position, every hostile archive held with its reason, the 1,000-member tier.
