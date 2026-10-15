# GRS-96: Browser viewers and manual previews for alpha file types

Decision support for [GRS-96](https://linear.app/vaper/issue/GRS-96). App base `8693ed886b7c641eacba76d06806f723f515cedb`. Sources read 15 October 2026. No app code changed, nothing built, deployed or tested in a browser. Labels: **[F]** fact from the cited primary source, **[I]** inference, **[R]** untested recommendation.

Inputs: the GRS-90 static facts (`grs-90-viewer-audit/.local/grs90-viewer-facts.md`), the accepted draft ADR 0011 on branch `grs-90-file-viewing-contract` (every accepted file viewable in the app, failed preview holds the whole update, no false citation precision), and the GRS-95 storage note at `8acba72` (workload aggregates only). No case file, `RAWS/`, production system or private screenshot was opened.

## Verdict

1. **Feasible for the alpha minimum, with one split of work.** The request Worker only authorizes and streams bytes from private R2. All parsing that decides preview readiness (Office conversion, email and MSG parsing, sheet extraction, archive expansion, media transcoding) runs in the operator's local processing step. It produces stored derivatives plus a manifest that candidate import checks before sign-off. [R]
2. **PDF and browser-native images need no derivative.** Word needs a paginated PDF rendition. Excel needs a structured sheet derivative, not a PDF. EML and MSG need a message derivative with every attachment extracted as its own fingerprinted child file. [R]
3. **Media playback: feasible but conditional.** Promise it only for files that play natively or that the operator transcodes to one baseline format. Any file that cannot be made playable holds the update (ADR 0011), so set expectations before accepting media. [I]
4. **Archives: feasible for ZIP only in the alpha,** through operator-side safe expansion into a manifest of child files, each previewed by its own family. Other archive formats and encrypted entries are manual-repair cases. [R]
5. **Workload context:** v5 is PDF 1,161, RFC 822 email 467, MSG 89 and "other" 13 MB in total, with 1,308 embedded assets (GRS-95 aggregates). Word, Excel, media and archives are rare or absent at v5. Their frequency in the 2,131-document export and in new clients is unknown. [F/I]

## Responsibilities

| Where | Does | Must not |
| --- | --- | --- |
| Request Worker (SvelteKit on Workers) | Clerk auth and per-client authorization; map asset id → R2 key; `R2Bucket.get(key, { range, onlyIf })` and stream the `ReadableStream` body as is; build `206` with `Content-Range`, `Accept-Ranges: bytes`, `Content-Length`; set `Content-Type` from the recorded type, `nosniff`, a sandbox CSP and `Content-Disposition`. [R] | Buffer whole files (128 MB isolate memory, WebAssembly included [F S1]); convert, parse or transcode; recompute sha256 per range read. [I] |
| Browser | pdf.js for PDFs and renditions; `<img>`, `<audio>`, `<video>`; render sheet, message and archive derivatives from JSON; email HTML in a sandboxed frame without `allow-scripts` and with remote loads blocked by CSP. [R] | Parse Office binaries or MSG at view time; compute formula values. [R] |
| Operator local step (manual, 24-36 h SLA) | Download → derive → write a derivative manifest → upload derivatives → candidate import. One CLI script, not a job platform. Cloudflare Containers can host the same script later (instances from 256 MiB to 12 GiB memory [F S16]). [R] | Modify originals. Each derivative records the source sha256, tool and version, and its own sha256. [R] |

**Preview readiness is a manifest check, not a runtime discovery.** Per accepted file, record `sourceSha256`, family, status `ready | failed`, the derivative keys and hashes, and the targets: page count, sheet names and cell ranges, message and attachment ids, archive entries. Candidate import refuses sign-off while any file is `failed` or missing. Citation targets are validated against that manifest at import, so an out-of-range page is an import error and never a silent clamp (GRS-90 found clamping in the local viewer). [R]

**The integrity contract is unchanged.** Originals stay byte-identical, keyed by sha256 (GRS-95). Derivatives sit beside them and are never offered as the original. The complete packet export still carries the originals. Whether to also carry derivatives is a user choice (see below). Range serving cannot re-hash a whole file per request; how the hosted app keeps the local "re-hash on serve" guarantee is GRS-95's open integrity question, and viewers must not settle it by default. [I]

## Per-family strategy

### PDF (and every PDF rendition)
- [F] pdf.js v6.4.299 (3 Oct 2026) is the latest release and is the version the app pins; Apache-2.0 [S2][S3].
- [F] pdf.js v6.4.299 uses range loading only when the response has an integer `Content-Length`, `Accept-Ranges: bytes`, `Content-Encoding` identity and a length over twice `rangeChunkSize` (default 65,536 bytes) [S4]. Otherwise it loads the whole file, which is today's behaviour for every file.
- [F] Cloudflare's default compression list does not include `application/pdf`. `Cache-Control: no-transform` from the origin disables compression [S5]. [R] Send `no-transform` on original and derivative responses anyway, so a future rule cannot break ranges or byte identity.
- [F] The API exposes `password` and `onPassword` [S4]. [I] An encrypted PDF needs the password from the client, or a decrypted private derivative. Both are manual-repair cases and a user decision.
- Fidelity: XFA forms are off by default (`enableXfa`) [F S4]. Annotations other than links are not shown today (GRS-90).

### Images
- [F] JPEG, PNG, GIF, WebP, BMP, SVG and AVIF have broad browser support; TIFF is native only in Safari; MDN does not cover HEIC [S6].
- [R] Serve native types as is. Convert TIFF (each page) and HEIC to PNG, or to a PDF for multi-page TIFF, in the operator step, and label the result as a rendition. Serve SVG only as `<img>` or in the sandboxed origin, never inline in the app DOM.

### Word (.docx, .doc, .rtf)
- [F] LibreOffice 26.8.1 is the current release, MPL-2.0 [S7][S8]. `soffice --headless --convert-to pdf --outdir DIR` converts documents. Pointing `-env:UserInstallation` at a fresh directory gives a separate profile per run [S9].
- [F] docx-preview 0.4.1 (Apache-2.0) renders DOCX to HTML and says it is "not pixel-perfect". It breaks pages only at manual breaks and at Word's `lastRenderedPageBreak` markers, which it ignores by default. It documents only `.docx` [S10]. Mammoth 1.13.0 (BSD-2-Clause) emits semantic HTML on purpose, drops visual styling and does not sanitise its output [S11].
- [R] Use a LibreOffice PDF rendition as the alpha view, shown in pdf.js and labelled "PDF rendition (LibreOffice 26.8.1) of the original". Page citations then refer to rendition pages. Neither HTML option gives stable pages.
- **Fidelity limit [I]:** LibreOffice's layout is not Word's. Pagination can differ when fonts are missing or substituted, so the operator machine needs the documents' fonts or metric-compatible ones. Tracked changes, comments and field results need fixture checks. **Critical unknown:** which pagination the supplied Word citations use (Word's, the source system's or none). If it is Word's, the rendition's page numbers can disagree, and those citations must be flagged file-level or repaired by hand, never mapped by guesswork.

### Excel (.xlsx, .xlsm, .xls, .xlsb)
- [F] SheetJS CE 0.20.3 is Apache-2.0 and is distributed from cdn.sheetjs.com; the npm `xlsx` package stops at 0.18.5 [S12][S13]. Cell objects carry `v` (underlying value), `w` (formatted text), `t` (type), `f` (formula) and `F`/`D` (array and dynamic array) [S14]. Sheet keys include `!ref`, `!merges`, `!cols`/`!rows` with visibility, `!autofilter` and `!protect` [S15]. Sheet `Hidden` is 0 visible, 1 hidden, 2 very hidden, across XLSX/XLSM/XLSB/XLS [S17]. Defined names are in `Workbook.Names` [S18].
- [F] "This library will not automatically compute formula results!": values come only from the file's cached results [S19]. CE reads row and column properties only with `cellStyles`; cell styling and conditional formatting are Pro features. CE decrypts only XOR-encrypted XLS and throws on other encryption [S20].
- [R] In the operator step, parse with SheetJS (`cellFormula`, `cellNF`, `cellStyles`, `cellDates` off so serials stay as stored) into a per-sheet JSON derivative: every non-empty cell with `v`, `w`, `t`, `f`, the merges, row and column visibility, sheet order and `Hidden` state, and defined names. The browser shows read-only sheet tabs and a searchable virtualized grid with the full value and formula in a cell detail panel. Cite targets as `sheet!A1:B9`, validated against `!ref`.
- **Fidelity limits [I]:** (a) A formula with no cached value shows the formula and "no stored value", never a computed one. (b) Hidden and very-hidden sheets, rows and columns are present and labelled; whether they appear by default is a user choice. (c) CE does not carry fills, fonts, conditional formats or charts, so the view keeps values and structure but not appearance. (d) Encrypted workbooks are manual repair. (e) Pivot caches and external links show only their stored values.
- [I] ExcelJS 4.4.0 (MIT) was last published in October 2023, so it is not the first choice. Converting a workbook to PDF flattens it and breaks ADR 0011, so a PDF can only be an optional extra.

### Email: EML and MSG
- [F] postal-mime 4.0.7 (MIT-0) runs in browsers, Bun and Cloudflare Workers. It returns ordered headers including raw lines, the addresses, `text`, `html` and attachments with `disposition`, `related`, `contentId` and content. It does not sanitise HTML. It holds the whole message in memory and has default limits (nesting 256, headers 2 MB, 10,000 parts, nested RFC 822 depth 10, after which `rfc822DepthExceeded` is set) [S21][S22].
- [F] @kenjiuno/msgreader 1.29.0 (Apache-2.0) reads MSG transport headers, the plain body, recipients, timestamps, attachments as bytes and the compressed RTF body. Its README does not mention HTML bodies or embedded `.msg` attachments [S23][S22]. @kenjiuno/decompressrtf 0.1.4 (BSD-2-Clause) was last published in 2021 [S22].
- [R] Build a message derivative in the operator step: headers (raw lines kept), a body view, and an attachment list. Extract each attachment as a child file with its own sha256, MIME type and its own preview through the matching family. Nested messages recurse up to a stated depth. This closes the GRS-90 gap of unfingerprinted embedded attachments. Render HTML in a sandboxed frame, with `cid:` images rewritten to child-file URLs, and block remote images (tracking) and scripts. Show the plain-text part next to it.
- **Fidelity limits [I]:** an MSG that was never sent has no transport headers, so show MAPI fields under a label. An RTF-only or RTF-encapsulated HTML body needs decompression and de-encapsulation, so show plain text with a label until fixtures prove that path. Calendar items, TNEF (`winmail.dat`) and S/MIME-signed or encrypted parts are manual-repair cases. Citations target `message` or `attachment:<child id>`; anything else is file-level.

### Audio and video
- [F] MDN recommends MP4 with H.264 video and AAC audio as the combination every major browser supports. H.264 and AAC are patent-encumbered, and Firefox uses the OS codecs for them. VP8, VP9 and AV1 are royalty-free. HEVC support depends on hardware, OS and an extension. MDN calls QuickTime MOV unsupported outside old Safari [S24][S25]. Opus in Ogg reached Safari only in 18.4 [S24]. AMR plays in neither Chrome (outside ChromeOS) nor Firefox, and MDN leaves Safari undetermined [S26].
- [F] FFmpeg 9.0.2 (18 Sep 2026) is the latest stable release. It is LGPL-2.1+ unless built with `--enable-gpl` or `--enable-nonfree`, and its legal page warns that codec patents may apply [S27][S28].
- [R] Play the original when its container and codec are in the baseline. Otherwise the operator transcodes to MP4/H.264/AAC, or WebM/VP9/Opus if patent licensing rules out H.264, and labels the result as a rendition. Seeking needs the Worker's `206` path. Cloudflare Stream is not needed at alpha scale.
- **Not proven:** iOS Safari seeking through a Worker-built `206`; long files; variable-frame-rate or rotated phone video; multi-track audio. MDN's tables document support. They are not test results for these browsers.

### Archives
- [F] ZIP APPNOTE 6.3.9: names "MUST NOT contain a drive or device letter, or a leading slash", use `/`. Bit 11 marks UTF-8 names, bit 0 marks encryption, ZIP64 is allowed at any size, and every entry carries a CRC-32 [S29].
- [R] Expansion in the operator step only, with no execution and nothing written outside a scratch directory. Reject or flag: absolute paths, `..` segments, drive letters, symlinks, duplicate names after normalization, and encrypted entries. Set limits on entry count, total and per-entry expanded size, compression ratio and nesting depth, and hold the update when a limit trips. Record per entry: the raw and decoded name, the sizes, the stored and verified CRC-32, the sha256, and the child asset id. Each child is a contained file with its own identity and family preview; the archive original stays byte-identical. The browser shows a folder tree from the manifest.
- [F] fflate 0.8.3 (MIT) and @zip.js/zip.js 2.23.0 (BSD-3-Clause) are maintained JS ZIP libraries [S22][S30]. [I] Either can run the expansion under Bun. 7z, RAR and TAR variants need a different tool, whose license was not checked here, so they are manual-repair cases for the alpha.

## R2, Worker and cost constraints
- [F] Workers set no response-size limit and no wall-clock limit on HTTP requests. CPU is 10 ms per request on Free and up to 5 min on Paid; memory is 128 MB per isolate; uploads are capped at 100 MB on Free and Pro plans [S1]. R2 egress is free; Class B costs $0.36 per million with 10 M free per month; storage costs $0.015 per GB-month with 10 GB-month free [S31]. Presigned URLs work only on the S3 endpoint, not on custom domains (GRS-95).
- [I] Each ranged `get()` is presumably one `GetObject`, billed as Class B; the pricing page does not say. At pdf.js's 64 KiB chunks, reading all of the largest v5 original (258,590,305 bytes) takes about 3,946 requests. That is arithmetic, not a measurement, and small against the free 10 M. Raising `rangeChunkSize` cuts it. Derivatives add storage roughly proportional to Office, media and archive volume, which is small at v5.
- [R] Serve originals and derivatives from a separate hostname (a Worker route) with the sandbox CSP, as the second loopback origin does today. Do not hand presigned S3 URLs to the viewer: they bypass Clerk authorization and the CSP.

## Choices for the user
1. Word: a LibreOffice PDF rendition with rendition-page citations (recommended), or HTML (not paginated).
2. Spreadsheets: show hidden and very-hidden sheets with a label (recommended) or hide them. Formulas without cached values show "no stored value" (recommended; computing values would be false precision).
3. Email: block remote content (recommended). Decide whether MSG with an RTF-only body may publish with a labelled plain-text view.
4. Encrypted PDFs, workbooks, archives and emails: client supplies the password, a private decrypted derivative, or the file is not accepted. ADR 0011 rules out download-only.
5. Media: accept only with a ready derivative or native playback, using MP4/H.264/AAC or WebM/VP9/Opus as the baseline.
6. Archives: ZIP only for the alpha; other types hold the update for manual repair.
7. Export packet: include derivatives and the manifest next to the originals, or originals only.

## Probes still needed (synthetic fixtures only)
- **Fixtures:** DOCX with missing fonts, tracked changes, comments and fields; `.doc`. XLSX with formulas lacking cached values, hidden and very-hidden sheets, merges, dates, more than 100k cells, XLS. EML with nested RFC 822, `cid:` images, non-UTF-8 charsets. MSG with RTF-only and HTML-in-RTF bodies, an embedded MSG, no transport headers. ZIP with traversal names, a zip bomb, an encrypted entry, CP437 names, a nested ZIP. MP4, MOV/HEVC, WebM, WAV, M4A, AMR.
- **Desktop and mobile:** Chrome, Firefox and Safari on desktop, iOS Safari and Android Chrome. Check pdf.js memory on the largest synthetic PDF, grid search on a large sheet, and media seeking.
- **Hosted:** a Worker range route on R2 (`206`, `If-Range`/ETag, `no-transform`), pdf.js range loading against it, and observed Class B counts.

## Sources (all read 15 Oct 2026)
- S1 Workers limits, updated 12 Oct 2026 <https://developers.cloudflare.com/workers/platform/limits/>
- S2 pdf.js releases <https://github.com/mozilla/pdf.js/releases> · S3 license <https://github.com/mozilla/pdf.js/blob/master/LICENSE>
- S4 pdf.js v6.4.299 source <https://github.com/mozilla/pdf.js/blob/v6.4.299/src/display/network_utils.js>, <https://github.com/mozilla/pdf.js/blob/v6.4.299/src/display/api.js>; API <https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html>
- S5 Cloudflare compression, updated 17 Apr 2026 <https://developers.cloudflare.com/speed/optimization/content/compression/>
- S6 MDN image types, modified 8 Oct 2026 <https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Image_types>
- S7 LibreOffice download <https://www.libreoffice.org/download/download-libreoffice/> · S8 licenses <https://www.libreoffice.org/about-us/licenses/> · S9 start parameters (26.8 Help) <https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html>
- S10 docx-preview <https://github.com/VolodymyrBaydalka/docxjs> · S11 Mammoth <https://github.com/mwilliamson/mammoth.js>
- S12 SheetJS install <https://docs.sheetjs.com/docs/getting-started/installation/nodejs> · S13 license <https://docs.sheetjs.com/docs/miscellany/license>
- S14 cells <https://docs.sheetjs.com/docs/csf/cell> · S15 sheets <https://docs.sheetjs.com/docs/csf/sheet> · S17 visibility <https://docs.sheetjs.com/docs/csf/features/visibility> · S18 workbook <https://docs.sheetjs.com/docs/csf/book> · S19 formulae <https://docs.sheetjs.com/docs/csf/features/formulae> · S20 parse options <https://docs.sheetjs.com/docs/api/parse-options>
- S16 Containers limits, updated 12 Oct 2026 <https://developers.cloudflare.com/containers/platform-details/limits/>
- S21 postal-mime <https://github.com/postalsys/postal-mime> · S23 msgreader <https://github.com/HiraokaHyperTools/msgreader>
- S22 npm registry metadata (version, license field, publish date), e.g. <https://registry.npmjs.org/postal-mime>. License files checked in the owners' repos for postal-mime, msgreader, mammoth, docx-preview, fflate, zip.js, ExcelJS.
- S24 MDN containers, modified 1 Oct 2026 <https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Containers> · S25 video codecs, modified 7 Sep 2026 <https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Video_codecs> · S26 audio codecs, modified 13 Oct 2026 <https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Audio_codecs>
- S27 FFmpeg download <https://ffmpeg.org/download.html> · S28 FFmpeg legal <https://ffmpeg.org/legal.html>
- S29 PKWARE APPNOTE 6.3.9 <https://pkwaredownloads.blob.core.windows.net/pkware-general/Documentation/APPNOTE-6.3.9.TXT>
- S30 fflate <https://github.com/101arrowz/fflate> · zip.js <https://github.com/gildas-lormeau/zip.js>
- S31 R2 pricing, updated 1 Oct 2026 <https://developers.cloudflare.com/r2/pricing/>; R2 Workers API, updated 31 Jul 2026 <https://developers.cloudflare.com/r2/api/workers/workers-api-reference/>

License facts come from the owners' license files and pages. They are not a compliance verdict: MPL-2.0 (LibreOffice, run as a separate tool), LGPL builds of FFmpeg, and codec patents need the user's own review.
