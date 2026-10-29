// GRS-273 scanned page: the reviewed reader and the real pinned pdf.js draw a synthetic scan to a canvas. pdf.js decodes
// CCITT fax (the usual office-scanner output) through its JBIG2 module, so without the decoder assets every scan drew
// blank while the viewer reported the page as rendered. pdf.js only warns when an image cannot be decoded; the reader
// must then reject the draw, so the viewer shows its error and download link instead of a blank page.
import { afterAll, beforeAll, expect, it } from 'vitest';
import { join } from 'node:path';
import { DOMMatrix, ImageData, Path2D, createCanvas, type Canvas } from '@napi-rs/canvas';
import { generatePdfAssets } from '../native-viewer/pdf-assets.ts';

const SRC = 'https://app.test/cases/case-a/originals/asset-1?t=synthetic';
// A synthetic 400x200 1-bit drawing (a frame and two bars), CCITT Group 4 with /K -1 and no /BlackIs1, as scanners write
// it: `magick -size 400x200 xc:white -fill black -draw "rectangle 20,20 380,180" -fill white -draw "rectangle 30,30 370,170"
// -fill black -draw "rectangle 50,60 350,80" -draw "rectangle 50,110 250,130" -monochrome -negate -compress Group4`, strip only.
const G4 = Buffer.from('///yIAzBt////+QhsX////////////////////////+RALYKv///////////////////////8f///////////////////////5EBkif///////////////////////x/////////////////////////////////j////8f//4AIAIA=', 'base64');

/** A one-page A3 landscape PDF whose page is the image `stream` (with its dictionary entries `dict`) and nothing else. */
function scan(dict: string, stream: Uint8Array) {
  const parts: (string | Uint8Array)[] = ['%PDF-1.4\n'];
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 1190.52 842.04] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>',
    [`<< /Type /XObject /Subtype /Image ${dict} /Length ${stream.byteLength} >>\nstream\n`, stream, '\nendstream'],
    '<< /Length 38 >>\nstream\nq 1190.52 0 0 842.04 0 0 cm /Im1 Do Q\nendstream'];
  const offsets: number[] = [];
  let length = parts[0]!.length;
  const push = (p: string | Uint8Array) => { parts.push(p); length += typeof p === 'string' ? p.length : p.byteLength; };
  objects.forEach((obj, i) => { offsets.push(length); push(`${i + 1} 0 obj\n`); for (const p of [obj].flat()) push(p); push('\nendobj\n'); });
  const start = length;
  push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`);
  return Buffer.concat(parts.map((p) => typeof p === 'string' ? Buffer.from(p, 'latin1') : p));
}
const ccitt = scan('/Width 400 /Height 200 /BitsPerComponent 1 /ColorSpace /DeviceGray /Filter /CCITTFaxDecode /DecodeParms << /Columns 400 /Rows 200 /K -1 >>', G4);
// A JPEG 2000 image whose stream is not one: no decoder can read it.
const broken = scan('/Width 400 /Height 200 /BitsPerComponent 8 /ColorSpace /DeviceGray /Filter /JPXDecode', new Uint8Array(512).fill(0x5a));

let bytes: Uint8Array = new Uint8Array();
async function original(input: RequestInfo | URL): Promise<Response> {
  if (String(input) !== SRC) throw new Error(`unexpected fetch ${String(input)}`);
  return new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'application/pdf', 'content-length': String(bytes.byteLength) } });
}
/** Pixels darker than light grey: what a reader sees as ink. */
function ink(canvas: Canvas) {
  const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
  let dark = 0;
  for (let i = 0; i < data.length; i += 4) if (data[i + 3]! > 0 && data[i]! < 128 && data[i + 1]! < 128 && data[i + 2]! < 128) dark++;
  return dark;
}

let assets: ReturnType<typeof generatePdfAssets>;
beforeAll(async () => {
  assets = generatePdfAssets();
  Object.assign(globalThis, { DOMMatrix, ImageData, Path2D, fetch: original, window: Object.assign(new EventTarget(), {
    requestAnimationFrame: (run: FrameRequestCallback) => setTimeout(() => run(performance.now()), 0),
    cancelAnimationFrame: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  }) });
  await import(/* @vite-ignore */ join(assets.dir, 'pdf-reader.mjs'));
});
afterAll(() => assets?.dispose());
type Reader = { pages: number; draw(n: number, s: number, fitWidth?: number): Promise<void>; destroy(): void };
const open = (canvas: Canvas) => (globalThis as unknown as { window: { clearcasePdfReader: { open(a: object): Promise<Reader> } } })
  .window.clearcasePdfReader.open({ src: SRC, size: bytes.byteLength, canvas, signal: new AbortController().signal });

it('draws a CCITT fax scan at phone width, not a blank canvas', async () => {
  bytes = ccitt;
  const canvas = createCanvas(1, 1), reader = await open(canvas);
  try {
    // The chronology pane on a 390 px phone gives the page 324 px.
    await reader.draw(1, 1.2, 324);
    expect([canvas.width, canvas.height]).toEqual([324, 229]);
    // The frame and bars cover about a quarter of the page.
    expect(ink(canvas)).toBeGreaterThan(324 * 229 * 0.15);
  } finally { reader.destroy(); }
});

it('rejects the draw of a page whose image cannot be decoded, so the viewer never shows it as rendered', async () => {
  bytes = broken;
  const reader = await open(createCanvas(1, 1));
  try { await expect(reader.draw(1, 1.2, 324)).rejects.toThrow(/image not decoded/); }
  finally { reader.destroy(); }
});
