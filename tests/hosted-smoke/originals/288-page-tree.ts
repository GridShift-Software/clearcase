// GRS-288: synthetic page trees of large originals that are not linearized, with each page's dictionary in its own stretch of
// the file, so reaching page N means reading through the file. Synthetic bytes only: filler spaces and one square per page.
export type Shape = 'flat' | 'nested' | 'balanced';
export type PageTree = { bytes: Uint8Array<ArrayBuffer>; pageOffsets: number[] };

/**
 * `pages` pages, each a page dictionary, its content and `gap` bytes of filler, then the xref table last.
 * - flat: every page is a kid of the root /Pages, as large scanned bundles are.
 * - nested: the root has one kid, a /Pages node holding every page.
 * - balanced: the root holds /Pages nodes of `fanout` pages each.
 * `descending` writes the pages last first, so page 1's dictionary is the one nearest the xref table.
 * `count` overrides the root's /Count (a malformed file's wrong count); every inner node keeps its true count.
 * Page n draws a 10x10 square at (n mod 9) * 10, 0, so a drawing shows which page it is.
 */
export function pageTree(a: { pages: number; gap: number; shape?: Shape; fanout?: number; descending?: boolean; count?: string }): PageTree {
  const { pages, gap, shape = 'flat', fanout = 32, descending = false } = a;
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (p: Uint8Array) => { parts.push(p); length += p.byteLength; };
  const filler = enc.encode(' '.repeat(gap));
  const object = (n: number, body: string | Uint8Array[]) => {
    offsets[n] = length;
    if (typeof body === 'string') return push(enc.encode(`${n} 0 obj\n${body}\nendobj\n`));
    push(enc.encode(`${n} 0 obj\n`)); for (const b of body) push(b); push(enc.encode('\nendobj\n'));
  };
  // Objects: 1 catalog, 2 root /Pages, then three per page (dictionary, content, filler), then any inner /Pages nodes.
  const pageRef = (i: number) => 3 + 3 * i;
  const inner = shape === 'nested' ? [Array.from({ length: pages }, (_, i) => i)]
    : shape === 'balanced' ? Array.from({ length: Math.ceil(pages / fanout) }, (_, k) => Array.from({ length: Math.min(fanout, pages - k * fanout) }, (_, j) => k * fanout + j))
      : [];
  const innerRef = (k: number) => 3 + 3 * pages + k;
  const parentOf = (i: number) => shape === 'flat' ? 2 : innerRef(shape === 'nested' ? 0 : Math.floor(i / fanout));
  push(enc.encode('%PDF-1.4\n% SYNTHETIC ONLY GRS-288\n'));
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  const rootKids = shape === 'flat' ? Array.from({ length: pages }, (_, i) => `${pageRef(i)} 0 R`) : inner.map((_, k) => `${innerRef(k)} 0 R`);
  object(2, `<< /Type /Pages /Kids [${rootKids.join(' ')}] /Count ${a.count ?? pages} >>`);
  inner.forEach((kids, k) => object(innerRef(k), `<< /Type /Pages /Parent 2 0 R /Kids [${kids.map((i) => `${pageRef(i)} 0 R`).join(' ')}] /Count ${kids.length} >>`));
  const order = Array.from({ length: pages }, (_, i) => descending ? pages - 1 - i : i);
  const pageOffsets: number[] = [];
  for (const i of order) {
    const ops = `${(i + 1) % 9 * 10} 0 10 10 re f`;
    pageOffsets[i] = length;
    object(pageRef(i), `<< /Type /Page /Parent ${parentOf(i)} 0 R /MediaBox [0 0 100 100] /Resources <<>> /Contents ${pageRef(i) + 1} 0 R >>`);
    object(pageRef(i) + 1, `<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`);
    object(pageRef(i) + 2, [enc.encode(`<< /Length ${gap} >>\nstream\n`), filler, enc.encode('\nendstream')]);
  }
  const size = 3 + 3 * pages + inner.length;
  const start = length;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (let n = 1; n < size; n++) xref += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  push(enc.encode(`${xref}trailer\n<< /Size ${size} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`));
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const p of parts) { bytes.set(p, at); at += p.byteLength; }
  return { bytes, pageOffsets };
}
