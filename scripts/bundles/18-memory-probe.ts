// Synthetic allocation probe. Run with node --expose-gc; no network, Blob, or prebuilt full-size source body.
import { pdfBytes, pdfDigest } from '../../src/lib/views/bundles/assembled.ts';
const length = 60 * 1024 * 1024,
	chunk = new Uint8Array(64 * 1024);
const magic = new TextEncoder().encode('%PDF-1.7\n'),
	eof = new TextEncoder().encode('%%EOF');
let sent = 0,
	peakBuffers = 0,
	peakRss = 0;
const sample = () => {
	const m = process.memoryUsage();
	peakBuffers = Math.max(peakBuffers, m.arrayBuffers);
	peakRss = Math.max(peakRss, m.rss);
};
globalThis.gc?.();
const start = process.memoryUsage();
const body = new ReadableStream<Uint8Array>(
	{
		pull(c) {
			sample();
			if (sent === length) {
				c.close();
				return;
			}
			chunk.fill(32);
			if (sent === 0) chunk.set(magic);
			if (sent + chunk.length === length)
				chunk.set(eof, chunk.length - eof.length);
			sent += chunk.length;
			c.enqueue(chunk);
		},
	},
	{ highWaterMark: 0 },
);
const request = new Request('http://synthetic.invalid', {
	method: 'POST',
	headers: {
		'content-type': 'application/pdf',
		'content-length': String(length),
	},
	body,
	duplex: 'half',
} as RequestInit);
const bytes = await pdfBytes(request);
if (!bytes || bytes.byteLength !== length) throw Error('Read failed');
sample();
const sha256 = pdfDigest(bytes);
sample();
if (sha256.length !== 64) throw Error('Digest failed');
// The write boundary receives the exact view read and hashed, never a copied payload.
const put = (value: Uint8Array) => {
	if (value !== bytes) throw Error('Copied upload');
	sample();
};
put(bytes);
const result = {
	bodyBytes: length,
	peakArrayBuffersDelta: peakBuffers - start.arrayBuffers,
	peakRssDelta: Math.max(peakRss, process.resourceUsage().maxRSS * 1024) - start.rss,
};
console.log(JSON.stringify(result));
if (
	result.peakArrayBuffersDelta > length * 1.1 ||
	result.peakRssDelta > length * 1.4
)
	throw Error('Upload memory exceeds near-one-body allocation ceiling');
