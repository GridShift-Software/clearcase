# Viewer handoff (GRS-97)

What the implementation owners ([GRS-120](https://linear.app/vaper/issue/GRS-120) to [GRS-123](https://linear.app/vaper/issue/GRS-123)) and the dependency owner ([GRS-112](https://linear.app/vaper/issue/GRS-112)) need from this evaluation. The contract is [contract.md](contract.md); the evidence is [coverage-matrix.md](coverage-matrix.md).

## Dependencies for GRS-112 to pre-add

Pin exactly these versions. Sizes were measured here, at the evaluation revision, by bundling each package alone with Bun 1.4.2 (`target: browser`, ESM, minified) and compressing with gzip level 9; they are per-format lazy chunks, not initial page weight. "B" is the browser reader (inside the opaque frame), "W" a Cloudflare Worker, "O" the operator workstation.

| Package | Version | Licence | Gzip bytes | Runs in | Used for |
| --- | --- | --- | --- | --- | --- |
| `pdfjs-dist` | 6.4.299 (already a root dependency) | Apache-2.0, plus bundled CMap/font/ICC notices (Adobe/Foxit BSD-style, CC0, Liberation GPL-2.0 with font exception) | 507,484 core + worker; 25,384 CSS; CMaps 985,971 and standard fonts 546,446 fetched per document on demand | B | PDF originals, prepared Word PDFs, workbook supplements |
| `xlsx` (SheetJS CE) | 0.20.3 from `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`, integrity `sha512-oLDq3jw7AcLqKWH2AhCpVTZl8mf6X2YReP+Neh0SJUzV/BdZYjth94tG5toiMB1PPrYtxOCfaoUCkvtuH+3AJA==` (npm's `xlsx` is the stale 0.18.5) | Apache-2.0 | 163,017 | B; also W or O for import-side validation | Workbook and CSV parsing |
| `tabulator-tables` | 6.6.1 | MIT | 106,268 JS + 3,949 CSS | B | Workbook grid |
| `postal-mime` | 4.0.11 | MIT-0 | 27,994 | B; W for the attachment graph | EML parsing |
| `@kenjiuno/msgreader` | 1.29.0, with `buffer` 6.0.3 as its browser polyfill | Apache-2.0; transitive `iconv-lite` 0.6.3, `safer-buffer` 2.1.2, `buffer` 6.0.3, `base64-js` 1.5.1 (MIT), `ieee754` 1.2.1 (BSD-3-Clause), `@kenjiuno/decompressrtf` 0.1.4 (BSD-2-Clause) | 178,624 (including the polyfills) | B; W needs a `nodejs_compat` proof | MSG parsing |
| `dompurify` | 3.4.17 | MPL-2.0 OR Apache-2.0 (select Apache-2.0) | 12,071 | B only (needs a DOM) | Email HTML sanitising |
| `fflate` | 0.8.3 | MIT | 3,432 (`Unzip`, `UnzipInflate`, `Inflate`) | B and W | ZIP members, bounded inflation |

Seven browser packages, **1,050,084 B gzip of JavaScript** in total (1,079,417 B with the two stylesheets), excluding pdf.js CMaps and fonts. Licences: 4 Apache-2.0 selections, 2 MIT, 1 MIT-0, plus the transitive MIT/BSD notices above.

Not pre-added: `docx-preview` 0.4.1 (Apache-2.0, 51,194 B gzip, with `jszip` 3.10.2 under MIT OR GPL-3.0-or-later, MIT selected). It rendered body, tables, headers, footers and footnotes, but by default it hides comments and tracked deletions, it has no page model, and the prepared PDF covers every citation need. If GRS-121 later wants an editable-layout companion view, add it then with `renderAltChunks: false` and external relationships stripped, as evaluated.

Evaluation-only (`tests/viewer-evaluation/package.json`, never shipped): `playwright-core` 1.64.1 (Apache-2.0) to drive Chrome for Testing, and `cfb` 1.2.2 (Apache-2.0) to write synthetic MSG fixtures.

SheetJS CE 0.20.3 reads a formula cell that has no stored result as `{t:'z', f, v:0}`, so `v` is not a result there: key on `t:'z'`. The recorded reader (`tests/viewer-evaluation/harness/renderers/sheet.mjs:42`: `cellFormula`, `cellNF`, `cellStyles` and `cellText`, no `sheetStubs`) shows it for B7 of `sheet/main.xlsx` (`results.json`, check "parser output alone distinguishes an absent formula result"). A viewer that reads with other options tests that cell with its own options.

Operator workstation tools (0 browser bytes), versions installed and used here:

| Tool | Version | Licence | Used for |
| --- | --- | --- | --- |
| LibreOffice | 26.2.6.3 | MPL-2.0 with mixed bundled licences | Prepared PDFs for DOCX and DOC (tagged, `ExportNotesInMargin`), workbook visual supplements |
| FFmpeg | 9.0.2 (distribution build; libx264 makes it GPL) | LGPL-2.1-or-later base; GPL with libx264 | Prepared H.264/AAC renditions for media the browser cannot play |
| ImageMagick | 7.1.2-32 | ImageMagick licence (Apache-2.0 style) | Prepared PNG page images for TIFF and HEIC |
| qpdf | 12.4.2 | Apache-2.0 | Decrypting a PDF for a prepared rendition, when the owner supplies the password |

Every conversion ran offline inside `unshare -rn`. The processing recipe must run them the same way, with macros and external links disabled.

## Recipe requirements found by the evaluation

These go to the owner of the human processing recipe; nothing here runs the recipe.

- Word: export tagged PDF with `ExportNotesInMargin=true`. The default export dropped the comment text (`word/full-content.default-export.pdf`). Tracked insertions and deletions appear as markup in the default export; the operator decides how material changes are presented (open question 3).
- Excel: never take a formula result from an office-rendered supplement. LibreOffice recalculated the cell that had no stored result and printed 20, and its print output omitted the hidden sheets, hidden row and column and the comment (`sheet/main.supplement-v1.pdf`). Its `.xls` export also stored the recalculated 20 and turned "very hidden" into "hidden". Supplements are for charts and visual formatting only; the grid from the original is the authority for values.
- TIFF/HEIC: one lossless PNG per source page, in page order, linked as `page-image` renditions with their page numbers.
- Media: H.264/AAC MP4 with faststart for sources Chrome cannot decode (AVI/MPEG-4 Part 2 here). A source with several audio tracks needs one rendition per material track or a reviewed mixdown: Chrome exposes no `audioTracks` API, so the second track is unreachable in the reader.
- PDF: an encrypted PDF needs the owner's password and a decrypted PDF linked as a `pdf` rendition (`qpdf --password=… --decrypt`); the hold clears only then.
- Email: an RTF-only body needs a reviewed plain-text companion linked as a `body-text` rendition (the reader shows it in place of the notice); a TNEF attachment needs a readable companion too, but no companion path is evaluated for TNEF; an mbox needs extraction into individual EML files with the mailbox hash and each message's byte offset recorded (open question 1).

## Proof still owed at the design gate

The harness used local bytes in one browser. These are not established and must be proved by their owners before or at the hosted design gate:

1. Original integrity before disclosure and range delivery (GRS-109/GRS-115): verify the whole original before any byte leaves storage, including `Range` and conditional requests, with REVIEW.md's "Range read before integrity check" probe. Media seeking here used a blob URL, not HTTP ranges.
2. A separate credential-free viewer origin on the hosted stack, with the reader CSP from contract section 5 served by the Worker, and the containment and broker checks re-run against it.
3. Firefox, WebKit, real iOS Safari and real Android Chrome: all **HOLD** (not installed, no devices). Mobile here is Chromium emulation at 390×844, which is not evidence for mobile codecs, memory or touch.
4. Screen readers (NVDA with Firefox, VoiceOver with Safari): not run. Keyboard checks passed; ARIA roles are present but no assistive-technology task was performed.
5. Owner-created real exports: an Outlook "Save as .msg", an Outlook/OWA "Download" EML, a Gmail "Download message" EML and a Gmail message forwarded as an attachment, with the export method and client version recorded. The fixtures here are structure models written by this harness, not exports from Outlook or Gmail; each carries a `provenance` record in the manifest saying so (`modelled: true`, `exportedFrom: null`).
6. Initial POC limits (open question 2) and their just-below/at/above checks; the tiers measured here are the starting tiers the user accepted ([decided 20 October 2026][decision]).
7. W-side parsing: `postal-mime`, `msgreader` (with `nodejs_compat`) and `fflate` were run in Bun and in the browser, not in workerd.

## Open questions and the defaults used

The pre-read raised five questions. The user accepted all five defaults on **[20 October 2026][decision]**. The [contract](contract.md#9-defaults-decided-20-october-2026) records them as decisions; this section repeats them for the implementation owners.

1. **Accepted codecs, image formats and archive methods.** Default: images PNG, JPEG, GIF, WebP, AVIF native; TIFF (including BigTIFF) and HEIC through prepared page images. Media: MP4/MOV/MKV with H.264/AAC, WebM VP9/Opus, MP3, WAV, Ogg Opus, M4A native; other video (AVI, HEVC) through a prepared H.264/AAC rendition. ZIP: stored or deflate, unencrypted, single volume, no ZIP64, nesting depth 3; encrypted, split, ZIP64 and other methods are held. Bulk mailboxes (mbox, PST, OST) are not accepted as one file; the operator extracts EML files and records the mailbox hash and offsets. 7z, RAR, gzip, bzip2, xz, zstd and tar, and bytes that match no reader, are held for manual extraction.
2. **Initial POC limits.** Default: the measured tiers (1,000 PDF pages, 100 MP image, 1m cells, 1,000 archive members) as the upper test points, ZIP members at most 64 MiB and 512 MiB total, 10,000 members. No latency or memory budget is enforced yet; measured times are reported.
3. **Reference application, fonts and presentation of tracked changes, hidden content, chart-only data, stale caches and embedded objects.** Default: LibreOffice 26.2 with the options above as the operator reference; comments in the margin; tracked changes as exported markup; hidden content and comments shown from the original in the grid; stored formula results shown as stored, without recalculation, and missing ones as "value unavailable".
4. **Who prepares and reviews OCR, RTF companions, captions and location maps, and the turnaround in "Preview pending processing".** Default: the operator running the processing recipe prepares and reviews them; there is no turnaround target; any unmappable supplied reference holds the whole update until the operator repairs it. While a file is processed, natively readable originals (PDF, native images, workbooks, email with a body, native media, ZIP) are viewable and only formats that need a prepared preview show "Preview pending processing". The accepted default extends the ADR's PDF and image examples.
5. **SheetJS CE cadence and operator licences.** Default: accept SheetJS CE 0.20.3 from the official CDN, pinned by integrity, with an update lane owned by GRS-112; accept LibreOffice (MPL) and a GPL FFmpeg build on the operator workstation only, with their notices kept. No commercial or external viewer or conversion service.

[decision]: https://linear.app/vaper/issue/GRS-27#comment-629983a8
