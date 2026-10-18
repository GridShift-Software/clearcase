import { deflateSync } from 'node:zlib';

export type Profile = 'small' | 'poc';
const enc = (s: string) => Buffer.from(s, 'utf8');
const KiB = 1024;
const MiB = KiB * KiB;

/** Invented target distribution, not sampled from case data. Targets exclude format overhead.
 * 60%: 16–128 KiB; 30%: 128 KiB–2 MiB; 9%: 2–8 MiB; 1%: 8–32 MiB.
 * Repeating inert padding exercises byte volume, not realistic compression, rendering or OCR cost.
 */
export function originalSize(profile: Profile, random: () => number): number {
  if (profile === 'small') return 0;
  const bucket = random();
  const [low, high] = bucket < 0.6 ? [16 * KiB, 128 * KiB]
    : bucket < 0.9 ? [128 * KiB, 2 * MiB]
    : bucket < 0.99 ? [2 * MiB, 8 * MiB] : [8 * MiB, 32 * MiB];
  return Math.floor(low + random() * (high - low));
}

/** Real PDF objects, stream lengths, byte offsets, xref and trailer. */
export function pdf(label: string, pages: number, targetBytes = 0): Uint8Array {
  const font = 3 + pages * 2;
  const objects: Uint8Array[] = [
    enc('<< /Type /Catalog /Pages 2 0 R >>'),
    enc(`<< /Type /Pages /Count ${pages} /Kids [${Array.from({ length: pages }, (_, i) => `${3 + i * 2} 0 R`).join(' ')}] >>`),
  ];
  for (let i = 0; i < pages; i++) {
    const safeLabel = label.replace(/[()\\]/g, '');
    const stream = enc(`BT /F1 12 Tf 32 720 Td (${safeLabel} - page ${i + 1} of ${pages}) Tj ET\n`);
    objects.push(enc(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${4 + i * 2} 0 R >>`));
    objects.push(Buffer.concat([enc(`<< /Length ${stream.length} >>\nstream\n`), stream, enc('endstream')]));
  }
  objects.push(enc('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'));
  if (targetBytes) {
    const padding = Buffer.alloc(targetBytes, 'SYNTHETIC ONLY\n');
    objects.push(Buffer.concat([enc(`<< /Length ${padding.length} >>\nstream\n`), padding, enc('\nendstream')]));
  }
  const parts: Uint8Array[] = [enc('%PDF-1.4\n% SYNTHETIC ONLY\n')];
  let offset = parts[0].length;
  const offsets: number[] = [];
  for (const [i, object] of objects.entries()) {
    offsets.push(offset);
    const bytes = Buffer.concat([enc(`${i + 1} 0 obj\n`), object, enc('\nendobj\n')]);
    parts.push(bytes);
    offset += bytes.length;
  }
  parts.push(enc(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    + offsets.map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')
    + `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`));
  return Buffer.concat(parts);
}

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(kind: string, data: Uint8Array): Uint8Array {
  const bytes = Buffer.alloc(12 + data.length);
  bytes.writeUInt32BE(data.length);
  bytes.write(kind, 4);
  bytes.set(data, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
  return bytes;
}

/** Seeded RGB PNG, with an ancillary text chunk for the poc byte target. */
export function png(integer: (n: number) => number, targetBytes = 0): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(4, 0);
  header.writeUInt32BE(4, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc(4 * 13);
  for (let y = 0; y < 4; y++) for (let x = 1; x < 13; x++) pixels[y * 13 + x] = integer(256);
  const chunks = [Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels))];
  if (targetBytes) chunks.push(chunk('tEXt', Buffer.concat([enc('Synthetic\0'), Buffer.alloc(targetBytes, 'SYNTHETIC ONLY ')])));
  chunks.push(chunk('IEND', new Uint8Array()));
  return Buffer.concat(chunks);
}

export function sizeSummary(sizes: number[]) {
  const sorted = sizes.toSorted((a, b) => a - b);
  return { min: sorted[0], median: sorted[Math.ceil(sorted.length / 2) - 1], p95: sorted[Math.ceil(sorted.length * 0.95) - 1], max: sorted.at(-1) };
}
