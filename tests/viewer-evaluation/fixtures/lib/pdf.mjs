// Minimal PDF 1.7 writer for synthetic fixtures. Objects are numbered in insertion order; streams are uncompressed
// unless the caller passes deflated bytes with a /Filter. Text uses the standard 14 Helvetica (not embedded) unless a
// page names another font resource.
import { deflateSync } from 'node:zlib';

const enc = new TextEncoder();
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

export class Pdf {
  objects = [];
  add(body) { this.objects.push(body); return this.objects.length; }
  reserve() { this.objects.push(null); return this.objects.length; }
  set(n, body) { this.objects[n - 1] = body; }
  stream(dict, data, compress = false) {
    let bytes = typeof data === 'string' ? enc.encode(data) : data;
    if (compress) { bytes = deflateSync(bytes); dict = `${dict} /Filter /FlateDecode`; }
    return { dict, bytes };
  }
  bytes(rootRef, infoRef) {
    const parts = [enc.encode('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n')];
    const offsets = [];
    let pos = parts[0].length;
    const push = (b) => { parts.push(b); pos += b.length; };
    this.objects.forEach((o, i) => {
      offsets.push(pos);
      if (o && typeof o === 'object') {
        push(enc.encode(`${i + 1} 0 obj\n<< ${o.dict} /Length ${o.bytes.length} >>\nstream\n`));
        push(o.bytes);
        push(enc.encode('\nendstream\nendobj\n'));
      } else push(enc.encode(`${i + 1} 0 obj\n${o ?? 'null'}\nendobj\n`));
    });
    const xref = pos;
    let x = `xref\n0 ${this.objects.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) x += `${String(off).padStart(10, '0')} 00000 n \n`;
    x += `trailer\n<< /Size ${this.objects.length + 1} /Root ${rootRef} 0 R${infoRef ? ` /Info ${infoRef} 0 R` : ''} >>\nstartxref\n${xref}\n%%EOF\n`;
    push(enc.encode(x));
    const out = new Uint8Array(pos);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

/**
 * Build a document. pages: [{ size:[w,h], rotate, lines:[[x,y,size,text]], cjk:[[x,y,size,text]], image:{w,h,rgb},
 * annots:[raw dict strings], aa: raw dict }]. opts: { labels: raw /PageLabels dict, openAction, acroForm(fn(pageRefs)),
 * names, title }.
 */
export function buildPdf(pages, opts = {}) {
  const pdf = new Pdf();
  const catalog = pdf.reserve();
  const pagesRef = pdf.reserve();
  const helv = pdf.add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  let cjkFont = null;
  if (pages.some((p) => p.cjk)) {
    const desc = pdf.add('<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 93 >>');
    const cid = pdf.add(`<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 4 >> /FontDescriptor ${desc} 0 R /DW 1000 >>`);
    cjkFont = pdf.add(`<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light-UniGB-UCS2-H /Encoding /UniGB-UCS2-H /DescendantFonts [${cid} 0 R] >>`);
  }
  const kids = [];
  const pageRefs = pages.map(() => pdf.reserve());
  pages.forEach((p, i) => {
    const [w, h] = p.size ?? [612, 792];
    let content = '';
    for (const [x, y, size, text] of p.lines ?? []) content += `BT /F1 ${size} Tf ${x} ${y} Td (${esc(text)}) Tj ET\n`;
    for (const [x, y, size, text] of p.cjk ?? []) {
      const hex = [...text].map((c) => c.codePointAt(0).toString(16).padStart(4, '0')).join('');
      content += `BT /F2 ${size} Tf ${x} ${y} Td <${hex}> Tj ET\n`;
    }
    let xobj = '';
    if (p.image) {
      const img = pdf.add(pdf.stream(`/Type /XObject /Subtype /Image /Width ${p.image.w} /Height ${p.image.h} /ColorSpace /DeviceRGB /BitsPerComponent 8`, p.image.rgb, true));
      xobj = ` /XObject << /Im1 ${img} 0 R >>`;
      content += `q ${w - 72} 0 0 ${h - 72} 36 36 cm /Im1 Do Q\n`;
    }
    const contents = pdf.add(pdf.stream('', content, true));
    const fonts = `/Font << /F1 ${helv} 0 R${cjkFont ? ` /F2 ${cjkFont} 0 R` : ''} >>`;
    const annots = (p.annots ?? []).map((a) => `${pdf.add(typeof a === 'function' ? a(pageRefs[i]) : a)} 0 R`);
    pdf.set(pageRefs[i], `<< /Type /Page /Parent ${pagesRef} 0 R /MediaBox [0 0 ${w} ${h}]${p.rotate ? ` /Rotate ${p.rotate}` : ''} /Resources << ${fonts}${xobj} >> /Contents ${contents} 0 R${annots.length ? ` /Annots [${annots.join(' ')}]` : ''}${p.aa ? ` /AA ${p.aa}` : ''} >>`);
    kids.push(`${pageRefs[i]} 0 R`);
  });
  pdf.set(pagesRef, `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`);
  let extra = '';
  if (opts.labels) extra += ` /PageLabels ${opts.labels}`;
  if (opts.openAction) extra += ` /OpenAction ${pdf.add(opts.openAction)} 0 R`;
  if (opts.names) extra += ` /Names ${opts.names(pdf)}`;
  if (opts.acroForm) extra += ` /AcroForm ${opts.acroForm(pdf, pageRefs)}`;
  pdf.set(catalog, `<< /Type /Catalog /Pages ${pagesRef} 0 R${extra} >>`);
  const info = pdf.add(`<< /Title (${esc(opts.title ?? 'Synthetic fixture')}) /Producer (ClearCase viewer-evaluation generator) >>`);
  return pdf.bytes(catalog, info);
}

/** Text pages with one unique token per page, for find and page-target checks. */
export function tokenPages(n, prefix, size = [612, 792]) {
  return Array.from({ length: n }, (_, i) => ({
    size,
    lines: [[72, size[1] - 96, 18, `${prefix}-${String(i + 1).padStart(4, '0')}`], [72, size[1] - 130, 11, `Synthetic page ${i + 1} of ${n}. Not case material.`]],
  }));
}
