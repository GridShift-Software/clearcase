# Viewer coverage matrix (GRS-97)

The frozen alpha file coverage, with the fixture evidence behind each cell. The rules built on it are in [contract.md](contract.md), the dependencies and open questions in [handoff.md](handoff.md).

| Evaluation | Value |
| --- | --- |
| Revision | `e0f3d7ecd7a60b0820e0437a3edbde1ab7e570e6`, harness tree `abcc6166054c7dc25a93f6475251a4dfbd2400b7`, clean (the tree is identical at every later commit of this branch, which change documents only). Re-run after the review of 3fc4b68; the first run was at `e083325` |
| Harness | `tests/viewer-evaluation/` (run instructions in its README), 104 synthetic fixtures generated in code (75 at `e083325`; 29 added for the review's classes) |
| Browser | Chrome for Testing 148.0.7778.96, headless, driven by `playwright-core` 1.64.1 |
| Network | `tests/e2e/pilot/offline.sh` (loopback only); the browser context also aborts and records any request leaving the harness origin |
| Viewports | 1440×900 and 1024×768 desktop; 390×844 Chromium mobile emulation (DPR 3, touch) |
| **HOLD** | Firefox, WebKit, real iOS Safari, real Android Chrome: not installed, no devices |
| Result | **418 PASS, 11 FAIL, 0 HOLD** in 429 checks (339 PASS, 11 FAIL in 350 before the fix round). The 11 FAILs are the same component findings as before, asserted on purpose (listed under [Findings](#findings)); none is new and none is a harness fault |

Raw results are in [results.json](results.json), a copy of the run's own `.local/viewer-evaluation/results.json` (per check: verdict, the assertion that decided it, and the observation; the Git revision and harness tree are inside it). Screenshots are under `.local/viewer-evaluation/screenshots/` (ignored, not committed).

Dispositions:

- **adopt**: use the component as is, with the settings named.
- **adapt**: use it behind a ClearCase adapter that adds what the evidence showed missing.
- **prepared rendition**: the operator's processing recipe produces a rendition, and another reader shows it.
- **unsupported**: held at candidate import, with no in-app preview.

## Totals by family

| Family | Components | Fixtures | PASS | FAIL |
| --- | --- | --- | --- | --- |
| PDF | pdf.js 6.4.299 | 12 | 52 | 0 |
| Image | native `<img>`; prepared PNG pages | 19 | 42 | 0 |
| Word | prepared PDF + pdf.js; docx-preview 0.4.1 (compared) | 7 | 37 | 4 |
| Workbook | SheetJS CE 0.20.3 + Tabulator 6.6.1; prepared supplement PDF | 9 | 54 | 5 |
| Email | postal-mime 4.0.11, @kenjiuno/msgreader 1.29.0, DOMPurify 3.4.17 | 10 | 45 | 0 |
| Media | native `<video>`/`<audio>`, WebVTT `<track>`; prepared MP4 | 14 | 38 | 2 |
| Archive | fflate 0.8.3 (bounded inflate) + plain-text reader | 13 | 46 | 0 |
| Containment | protected shell and broker | 2 | 13 | 0 |
| Descriptor | one validator in the shell and every reader; every field mutated | 11 descriptors | 27 | 0 |
| Import classes | unknown bytes, family from bytes, depth and budget, page images, Gmail forward | 15 + 7 | 41 | 0 |
| Readiness | import holds + reader smoke + location resolution | 9 candidates + processing state | 23 | 0 |

## Format coverage

PASS/FAIL counts are per fixture across all viewports.

| Family | Format or variant | Disposition | Component and settings | Fixture evidence |
| --- | --- | --- | --- | --- |
| PDF | Text PDF: labels, mixed sizes, `/Rotate`, attributes inherited through the page tree, `/Contents` arrays | adopt | pdf.js; scripting, XFA, forms and WASM off; `isEvalSupported: false`; main-thread worker | `text-basic.pdf` 30/0, `mixed-pages-labels.pdf` 6/0, `inherited-attributes.pdf` 3/0 |
| PDF | Non-embedded CJK font | adopt | pdf.js CMaps from a static path, no credentials | `cjk-nonembedded.pdf` 3/0 |
| PDF | JavaScript, OpenAction, launch and URI actions | adopt | Detected and labelled, never run; links inert | `hostile-actions.pdf` 5/0 |
| PDF | Scanned, no text layer | adopt + prepared rendition | OCR text companion (`ocr-text`), shown as such | `scanned-no-text.pdf` 4/0 |
| PDF | Damaged (no trailer) | unsupported | Held `pdf-damaged`, even though pdf.js recovers pages | `truncated.pdf` 1/0 |
| PDF | Encrypted (reference or inline `/Encrypt`) | prepared rendition | Decrypted PDF from the owner's password (`qpdf --decrypt`) linked as a `pdf` rendition; held until it is, and the reader fails explicitly on the original | held: `encrypted-user-password.pdf` 2/0, `encrypted-inline-dict.pdf` 2/0; cleared by a linked rendition and previewed through it: `encrypted-with-rendition.pdf` (candidate H) |
| Image | PNG, JPEG with EXIF orientation, PNG alpha, animated GIF, WebP, AVIF | adapt | Native `<img>`; sniff before decode; fall back from `decode()` to load + `createImageBitmap` for very large images | `png-pattern.png` 12/0, `jpeg-exif-orientation-6.jpg` 3/0, `png-alpha.png` 2/0, `gif-animated-3.gif` 2/0, `webp-pattern.webp` 2/0, `avif-pattern.avif` 2/0 |
| Image | TIFF: G4 multipage, LZW, JPEG-compressed, BigTIFF | prepared rendition | One PNG per page, found by the `rendition.page` in each image's own descriptor (not by position); the set must be exactly pages 1 to N, N counted from the file, or the update is held `rendition-page-count-mismatch`; a missing page is `unmapped-original-location` | `tiff-multipage-g4.tif` 6/0 (also with the images supplied out of order), `tiff-gappy.tif` 3/0 (pages 1 and 3 of 3), `tiff-lzw.tif` 1/0, `tiff-jpeg.tif` 1/0, `bigtiff.tif` 1/0 |
| Image | HEIC | prepared rendition | PNG rendition | `heic-pattern.heic` 2/0 |
| Image | PNG whose compressed data is corrupt (signature and header valid) | unsupported by the reader, not by import | No import hold; the reader fails with `decode-failed` and the update is held through `preview-failed` | `png-corrupt-body.png` (candidate F) |
| Image | SVG or HTML bytes under an image name | unsupported | Held at import; the shell refuses `family: 'unknown'`; the image reader refuses it too when forced | `svg-masquerade.png` 3/0, `html-masquerade.jpg` 3/0 |
| Word | DOCX | prepared rendition | Tagged PDF from LibreOffice with `ExportNotesInMargin`, in pdf.js; docx-preview not adopted | `full-content.rendition-v1.pdf` 17/0 (+3/0 with a verified page map), `full-content.docx` 6/3, `full-content.default-export.pdf` 1/1 |
| Word | DOCX with altChunk HTML | prepared rendition | docx-preview with `renderAltChunks: false` never runs the HTML | `altchunk.docx` 4/0 |
| Word | DOC (binary) | prepared rendition | Same recipe | `legacy.doc` 2/0, `legacy.rendition-v1.pdf` 1/0 |
| Workbook | XLSX, including 1904 dates | adapt | SheetJS CE + Tabulator; formula with `t: 'z'` shown as formula + "value unavailable"; cell text as DOM text, never HTML | `main.xlsx` 32/1, `main-1904.xlsx` 2/0 |
| Workbook | XLS | adapt | Same; the fixture was written by LibreOffice. A formula with no stored result is **unevaluated**: LibreOffice recalculated it when it wrote the fixture, so no `.xls` without a stored result was read | `main.xls` 7/1 |
| Workbook | CSV | adapt | Raw strings, no formula evaluation, no type coercion | `data.csv` 2/1 |
| Workbook | Charts and drawings | prepared rendition | Supplement PDF for the visual only; values stay from the grid | `chart.xlsx` 3/0, `chart.supplement-v1.pdf` 2/0 |
| Workbook | Office-rendered supplement as a source of values | unsupported | Recalculates and drops hidden content | `main.supplement-v1.pdf` 1/2 |
| Email | EML, Gmail and Outlook download shapes | adapt | postal-mime; DOMPurify; body in a nested `sandbox=""` frame; CID images as `data:` | `gmail-download.eml` 22/0, `outlook-download.eml` 6/0 |
| Email | MSG with a nested message | adapt | msgreader with `buffer`; same sanitiser and attachment graph | `outlook-save-as.msg` 6/0 |
| Email | MSG with an RTF-only body | prepared rendition | Readable companion linked as a `body-text` rendition, shown in place of the pending notice; held `rtf-only-body-needs-companion` until it exists | held: `outlook-rtf-only.msg` 2/0; cleared: `outlook-rtf-only-with-companion.msg` (candidate I, 2/0) |
| Email | Hostile HTML, malformed base64 | adapt | Sanitised with zero egress; the MIME hold keeps the update back | `hostile.eml` 6/0 |
| Email | TNEF `winmail.dat` | prepared rendition, **unevaluated** | Held `tnef-needs-companion`. No companion fixture exists, so that a companion clears the hold is not shown | `hostile.eml` (held only) |
| Email | Gmail message forwarded as an attachment: `message/rfc822` carrying a PDF and an earlier message, Gmail transport headers | adapt | postal-mime; both messages open in the email reader from the trusted child list; headers kept in order. The fixture is a structure model whose manifest says `modelled: true, exportedFrom: null` | `gmail-forwarded.eml` 4/0 |
| Email | mbox, PST and OST (`!BDN`) | unsupported as one file | Manual extraction into EML files; held at the top level, inside a ZIP and attached to an EML | `gmail-takeout.mbox` 2/0, `unknown/synthetic-mailbox.pst` 3/0, `unknown/synthetic-cache.ost` 3/0 |
| Media | MP4 H.264/AAC (faststart and moov-at-end), MOV, MKV | adopt | Native `<video>` from a blob URL; WebVTT `<track>` | `mp4-h264-aac-faststart.mp4` 16/0, `mp4-h264-aac-moov-end.mp4` 2/0, `mov-h264-aac.mov` 2/0, `mkv-h264-aac.mkv` 2/0 |
| Media | WebM VP9/Opus | adopt | Native | `webm-vp9-opus.webm` 2/0 |
| Media | MP3, WAV, Ogg Opus, M4A, one-hour MP3 | adopt | Native `<audio>` | `mp3-sine.mp3` 1/0, `wav-pcm.wav` 1/0, `ogg-opus.ogg` 1/0, `m4a-aac.m4a` 1/0, `mp3-one-hour.mp3` 1/0 |
| Media | AVI (MPEG-4 Part 2, MP3) | prepared rendition | H.264/AAC MP4; the original fails explicitly | `avi-mpeg4-mp3.avi` 1/0, `avi-mpeg4-mp3.rendition-v1.mp4` 2/0 |
| Media | Several audio tracks | prepared rendition | One rendition per material track or a reviewed mixdown | `mp4-two-audio-tracks.mp4` 2/1 |
| Media | Truncated MP4 | unsupported | Held `media-damaged` by the import box walk | `mp4-truncated.mp4` 1/1 |
| Media | HEVC | **unevaluated** | No fixture. Import's list of formats that need a prepared rendition does not name HEVC, so an HEVC file is not held for one today | none |
| Media | Truncated WebM, MKV, MP3, Ogg | **unevaluated** | The import box walk covers ISO BMFF (MP4, MOV, M4A) only; no truncated fixture exists for the others | none |
| Archive | ZIP, stored and deflate: directories, empty and Unicode members, 1,000 members | adapt | fflate inflation capped at 64 MiB per member, CRC-32 checked; members open in their own readers | `basic.zip` 19/0, `many-1000.zip` 2/0 |
| Archive | Unknown or unsupported bytes (7z, RAR, gzip/`.tgz`, bytes with no signature) | unsupported | Held (`unsupported-container-…`, `unrecognised-format`) at the top level, as a ZIP member and as an EML attachment; never shown as text | `unknown/synthetic-archive.7z`, `.rar`, `synthetic-takeout.tgz`, `opaque.bin` 3/0 each, `unknown-members.zip` and `unknown-attachments.eml` (candidate G) |
| Archive | Files renamed to mislead: DOCX/XLSX named `.zip`, ZIP named `.docx`, `.doc`/`.xls`/`.msg` named `.dat`, `.msg` named `.doc`, a PowerPoint-shaped package | adapt | The family comes from the OOXML parts or the OLE directory; the PowerPoint-shaped package is `unknown`, held `unsupported-office-format` | `rename/*` 1/0 each (nine fixtures) |
| Archive | Nesting: six ZIPs, and a ZIP/EML alternating chain | unsupported beyond depth 3 | One depth counter for both; the container at the limit is held `nesting-limit` and not expanded. One expansion budget for the tree (checked at a 1,000,000-byte cap) | `nest-zip-6.zip` 1/0, `nest-eml-zip-chain.zip` 1/0, `budget-mixed.zip` 1/0 |
| Archive | Duplicate member names | adapt | Kept by position; citing the duplicated name is refused | `duplicates.zip` 4/0 |
| Archive | Traversal and symlink, CRC mismatch, encrypted, unsupported method, declared and lying-size bombs | unsupported | Held, each with its reason | `traversal.zip`, `corrupt-crc.zip`, `encrypted-flag.zip`, `unsupported-method.zip`, `bomb-256mib.zip`, `bomb-lying-size.zip`: 3/0 each |
| Archive | ZIP64, split archives | unsupported, **unevaluated** | Held by the import code; no fixture exercised it | none |
| Archive | Total expansion over 512 MiB and more than 10,000 items in a tree | unsupported, **unevaluated** at the stated limits | The code is exercised at a 1,000,000-byte cap only; no fixture reaches 512 MiB or 10,000 items | `budget-mixed.zip` at the lowered cap |
| Text | Plain text members and OCR companions | adopt | Plain-text reader | via `basic.zip` member 1 and `scanned-no-text.ocr.txt` |

## Location mapping

Every family resolves the target kinds in contract section 4 and refuses the rest without moving the view.

- **PDF.** Physical pages and page labels resolve; ambiguous and absent labels and out-of-range pages are refused (`mixed-pages-labels.pdf`, `text-basic.pdf`).
- **Prepared renditions.**
  - Word renditions accept `rendition-page` at the current version and refuse a stale version (`stale-rendition`).
  - They refuse `original-page` (`unmapped-original-location`) unless the descriptor carries a verified page map (`full-content.rendition-v1.pdf@verified-map` 3/0).
  - TIFF page images resolve by original page through each image's own `rendition.page`; a page with no image is `unmapped-original-location`, and a set that is not exactly pages 1 to N holds the update.
- **Workbooks.** Cells and ranges resolve by exact sheet name. Out-of-grid references and case-different sheet names are refused; a cell outside the used range is labelled empty.
- **Email.** Attachments resolve by key or by a unique name; a duplicated name is refused.
- **Media.** Times resolve within the duration, and seek accuracy was checked by frame colour.
- **Archives.** Members resolve by ordinal or by a unique path.

## Viewports and keyboard

Each family's main fixture passed the layout and keyboard checks at all three viewports:

- no horizontal scroll of the shell or reader chrome;
- controls inside the viewport and touch targets of at least 24 CSS px on mobile;
- Tab from the shell's close control enters the reader, and Escape returns focus to the shell.

By viewport: 1440×900 274 PASS and 11 FAIL (all component findings); 1024×768 29 PASS; 390×844 36 PASS. The mobile numbers are Chromium emulation only, not device evidence.

## Scale

These are measurements at the proposed starting tiers on desktop Chrome, not agreed limits (open question 2).

| Tier | Fixture | Result |
| --- | --- | --- |
| 1,000-page PDF | `pdf/large-1000-pages.pdf` | ready 110 ms; jump to the last page 87 ms; find across all pages 207 ms |
| 20 MP image | `image/large-20mp.png` | ready; `decode()` 121 ms |
| 100 MP image | `image/large-100mp.png` | ready in 1,158 ms through the load + `createImageBitmap` fallback, because `decode()` rejected it |
| 100k populated cells | `sheet/large-100k-cells.xlsx` | ready 313 ms (parse 189, grid 62, search 87) |
| 1m populated cells | `sheet/large-1m-cells.xlsx` | ready 2,127 ms (parse 1,717, grid 98, search 575) |
| One-hour audio | `media/mp3-one-hour.mp3` | ready 46 ms; seek to 59:00 accepted |
| 1,000 archive members | `archive/many-1000.zip` | ready 73 ms; listed and verified 33 ms |

## Containment

All 13 containment checks pass at every viewport:

- **Reader isolation.** The reader has an opaque origin. It cannot read cookies or storage. A credentialed `fetch` of a case asset is refused, and no authorized request reaches the server. Top navigation, popups and parent DOM access all fail.
- **Broker protocol.** A forged `hello`, a wrong nonce and a navigation before the claim each yield zero bytes.
- **Integrity.** A hash mismatch stops before a frame exists.
- **Descriptor validation.** The 14 original deleted, null or retyped fields are refused by the shell. `descriptor.mjs` goes further: it mutates every field of 11 descriptors (67 to 141 mutations each, arrays at elements 0 and 1) and the shell refuses all of them; each reader, with the shell's check skipped, refuses all of them again (`invalid-descriptor`); `role` deleted, null or retyped on an unmapped rendition never lets `original-page 2` resolve.
- **Session monitor.** Over every family run it recorded zero egress, dialogs, popups and top-level navigations.

## Readiness candidates

| Candidate | Expected | Result |
| --- | --- | --- |
| Processing state (22 originals) | Natively readable originals viewable (PDF, native images, workbooks, EML/MSG with a body, native media, ZIP); only formats that need a prepared preview "Preview pending processing"; SVG/HTML refused. The old table narrowed workbooks, email, media and ZIP to pending; the ADR does not say that (contract section 1) | PASS; each of the 9 "viewable" originals opens in its reader |
| A: complete update, eight files (PDF, PNG, TIFF, DOCX, XLSX, EML, MP4, ZIP) | Ready to publish | PASS, no reasons |
| B: A plus `hostile.eml` | Held, every reason on `hostile.eml` or its children | PASS (`malformed-mime-part`, `tnef-needs-companion` on the message; `unrecognised-format` and `no-reader` on its two children, which are held again as `child-preview-failed:no-reader`) |
| C: unmatched supplied locations | Held, one code per location | PASS (`invalid-target` ×2, `ambiguous-attachment`, `unmapped-original-location`) |
| D: citation to rendition version 2 | Held | PASS (`stale-rendition`) |
| E: TIFF without a prepared rendition | Held | PASS (`prepared-rendition-missing`, `required-preview-missing`) |
| F: a file that passes import whose reader fails (`png-corrupt-body.png`) | Held through `preview-failed:*` with no import hold on the file | PASS (`preview-failed:decode-failed`). The branch worked at `3fc4b68` and no candidate reached it; with reader errors ignored in `evaluate()` this check fails |
| G: unknown and unsupported bytes inside a ZIP and on an EML | Held, every one of the six blobs in each container carries a hold | PASS (`bulk-mailbox-…`, `unsupported-container-…`, `unrecognised-format`, each with `child-preview-failed:no-reader`) |
| H: encrypted PDF with a decrypted rendition; the unlinked twin | Ready; the twin held | PASS (`pdf-encrypted-needs-decrypted-rendition` on the twin only) |
| I: RTF-only MSG with a reviewed companion; the unlinked twin | Ready, companion shown by the reader; the twin held | PASS (`rtf-only-body-needs-companion` on the twin only) |

## Findings

The 11 FAILs. Each assertion was written to fail if the component behaves the way that matters to ClearCase.

| Fixture | What failed | Consequence |
| --- | --- | --- |
| `word/full-content.default-export.pdf` | LibreOffice's default PDF export drops the comment text | The recipe sets `ExportNotesInMargin=true`; the recipe rendition passes 17/0 |
| `word/full-content.docx` ×3 | docx-preview hides comments and tracked deletions by default; with `renderComments` and `renderChanges` enabled, the comment text is still not in the rendered text | docx-preview is not adopted; DOCX goes through the prepared PDF |
| `sheet/main.xlsx` | SheetJS CE parses a formula with no stored result as `{ t: 'z', v: 0 }` | The adapter keys on `t === 'z'` with a formula present; the reader check (formula + "value unavailable") passes |
| `sheet/main.xls` | LibreOffice's `.xls` export stored the recalculated 20 and turned "very hidden" into "hidden" | Converted workbooks are not a value source |
| `sheet/data.csv` | After SheetJS parsing, a quoted empty field (`""`) and a missing field are both empty | Accepted for alpha (follow-up: parse CSV in the adapter if the distinction matters) |
| `sheet/main.supplement-v1.pdf` ×2 | The office supplement recalculated the absent result to 20 and omitted the hidden sheets, row, column and comment | Supplements are visual-only; values come from the grid |
| `media/mp4-two-audio-tracks.mp4` | Chrome exposes no `audioTracks` API, so the second track is unreachable | Prepared rendition per material track |
| `media/mp4-truncated.mp4` | Chrome plays a cut MP4 as complete and shows a black frame past the cut | Import holds it (`media-damaged`); the reader alone cannot be trusted to fail |
