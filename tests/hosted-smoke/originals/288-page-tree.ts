// GRS-288: synthetic page trees of large originals that are not linearized, with each page's dictionary in its own stretch of
// the file, so reaching page N means reading through the file. Synthetic bytes only: filler spaces, light grey images and
// one square per page.
export type Shape = 'flat' | 'nested' | 'balanced';
/** A byte range of the file: page-tree and cross-reference metadata, or page `page`'s own content (its stream and image). */
export type Region = { start: number; end: number; kind: 'meta' | 'content'; page?: number };
export type PageTree = { bytes: Uint8Array<ArrayBuffer>; pageOffsets: number[]; regions: Region[] };

/**
 * `pages` pages, each a page dictionary, its content and then either `gap` bytes of filler or, with `image`, an
 * uncompressed `image` x `image` grey image the page draws (a scanned page's weight), then the xref table last.
 * - flat: every page is a kid of the root /Pages, as large scanned bundles are.
 * - nested: the root has one kid, a /Pages node holding every page.
 * - balanced: the root holds /Pages nodes of `fanout` pages each.
 * `descending` writes the pages last first, so page 1's dictionary is the one nearest the xref table.
 * `count` overrides the root's /Count (a malformed file's wrong count); every inner node keeps its true count.
 * `pad` adds that many unused objects before the pages, so the xref table is as long as a file with many small objects has.
 * Page n draws a 10x10 square at (n mod 9) * 10, 0, so a drawing shows which page it is; its image, if any, is light grey.
 */
export function pageTree(a: { pages: number; gap: number; image?: number; shape?: Shape; fanout?: number; descending?: boolean; count?: string; pad?: number }): PageTree {
  const { pages, gap, image, shape = 'flat', fanout = 32, descending = false, pad = 0 } = a;
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  const regions: Region[] = [];
  let length = 0;
  const push = (p: Uint8Array) => { parts.push(p); length += p.byteLength; };
  const filler = image ? new Uint8Array(image * image).fill(0xe0) : enc.encode(' '.repeat(gap));
  const object = (n: number, body: string | Uint8Array[]) => {
    offsets[n] = length;
    if (typeof body === 'string') return push(enc.encode(`${n} 0 obj\n${body}\nendobj\n`));
    push(enc.encode(`${n} 0 obj\n`)); for (const b of body) push(b); push(enc.encode('\nendobj\n'));
  };
  const region = (kind: Region['kind'], page: number | undefined, write: () => void) => {
    const start = length; write(); regions.push({ start, end: length, kind, page });
  };
  // Objects: 1 catalog, 2 root /Pages, then three per page (dictionary, content, filler or image), then any inner /Pages nodes.
  const pageRef = (i: number) => 3 + 3 * i;
  const inner = shape === 'nested' ? [Array.from({ length: pages }, (_, i) => i)]
    : shape === 'balanced' ? Array.from({ length: Math.ceil(pages / fanout) }, (_, k) => Array.from({ length: Math.min(fanout, pages - k * fanout) }, (_, j) => k * fanout + j))
      : [];
  const innerRef = (k: number) => 3 + 3 * pages + k;
  const parentOf = (i: number) => shape === 'flat' ? 2 : innerRef(shape === 'nested' ? 0 : Math.floor(i / fanout));
  region('meta', undefined, () => {
    push(enc.encode('%PDF-1.4\n% SYNTHETIC ONLY GRS-288\n'));
    object(1, '<< /Type /Catalog /Pages 2 0 R >>');
    const rootKids = shape === 'flat' ? Array.from({ length: pages }, (_, i) => `${pageRef(i)} 0 R`) : inner.map((_, k) => `${innerRef(k)} 0 R`);
    object(2, `<< /Type /Pages /Kids [${rootKids.join(' ')}] /Count ${a.count ?? pages} >>`);
    inner.forEach((kids, k) => object(innerRef(k), `<< /Type /Pages /Parent 2 0 R /Kids [${kids.map((i) => `${pageRef(i)} 0 R`).join(' ')}] /Count ${kids.length} >>`));
    for (let k = 0; k < pad; k++) object(innerRef(inner.length) + k, 'null');
  });
  const order = Array.from({ length: pages }, (_, i) => descending ? pages - 1 - i : i);
  const pageOffsets: number[] = [];
  for (const i of order) {
    const ops = `${image ? `q 80 0 0 80 10 10 cm /Im0 Do Q ` : ''}${(i + 1) % 9 * 10} 0 10 10 re f`;
    const resources = image ? `<< /XObject << /Im0 ${pageRef(i) + 2} 0 R >> >>` : '<<>>';
    pageOffsets[i] = length;
    region('meta', i, () => object(pageRef(i), `<< /Type /Page /Parent ${parentOf(i)} 0 R /MediaBox [0 0 100 100] /Resources ${resources} /Contents ${pageRef(i) + 1} 0 R >>`));
    region('content', i, () => {
      object(pageRef(i) + 1, `<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`);
      const head = image ? `<< /Type /XObject /Subtype /Image /Width ${image} /Height ${image} /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${filler.byteLength} >>` : `<< /Length ${gap} >>`;
      object(pageRef(i) + 2, [enc.encode(`${head}\nstream\n`), filler, enc.encode('\nendstream')]);
    });
  }
  const size = 3 + 3 * pages + inner.length + pad;
  region('meta', undefined, () => {
    const start = length;
    let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
    for (let n = 1; n < size; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
    push(enc.encode(`${xref}trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`));
  });
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const p of parts) { bytes.set(p, at); at += p.byteLength; }
  return { bytes, pageOffsets, regions: regions.sort((x, y) => x.start - y.start) };
}
