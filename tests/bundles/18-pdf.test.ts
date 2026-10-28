import { expect, test } from 'vitest';
import {
	pdfBytes,
	MAX_PDF_BYTES,
	bundleObjectKey,
} from '../../src/lib/views/bundles/assembled';
const request = (body: string, headers: Record<string, string> = {}) =>
	new Request('http://test', {
		method: 'POST',
		headers: {
			'content-type': 'application/pdf',
			'content-length': String(body.length),
			...headers,
		},
		body,
	});
test('raw PDF bytes require a bounded Content-Length and matching byte count', async () => {
	const pdf = '%PDF-1.7\nsynthetic\n%%EOF';
	expect(await pdfBytes(request(pdf))).toEqual(new TextEncoder().encode(pdf));
	expect(
		await pdfBytes(new Request('http://test', { method: 'POST', body: pdf })),
	).toBeNull();
	expect(
		await pdfBytes(
			request(pdf, { 'content-length': String(MAX_PDF_BYTES + 1) }),
		),
	).toBeNull();
	expect(
		await pdfBytes(request(pdf, { 'content-length': String(pdf.length - 1) })),
	).toBeNull();
	expect(
		await pdfBytes(request(pdf, { 'content-length': String(pdf.length + 1) })),
	).toBeNull();
});
test('non-PDF bytes cancel after the first chunk without reading the rest', async () => {
	let pulls = 0,
		cancelled = false;
	const body = new ReadableStream<Uint8Array>(
		{
			pull(c) {
				pulls++;
				c.enqueue(new TextEncoder().encode('not a PDF'));
			},
			cancel() {
				cancelled = true;
			},
		},
		{ highWaterMark: 0 },
	);
	const r = new Request('http://test', {
		method: 'POST',
		headers: {
			'content-type': 'application/pdf',
			'content-length': String(MAX_PDF_BYTES),
		},
		body,
		duplex: 'half',
	} as RequestInit);
	expect(await pdfBytes(r)).toBeNull();
	expect(pulls).toBe(1);
	expect(cancelled).toBe(true);
});
test('split valid magic is accepted across transport chunks', async () => {
	const chunks = ['%P', 'DF-1.7\n', '%%EOF'];
	let i = 0;
	const body = new ReadableStream(
		{
			pull(c) {
				if (i === chunks.length) c.close();
				else c.enqueue(new TextEncoder().encode(chunks[i++]));
			},
		},
		{ highWaterMark: 0 },
	);
	expect(
		await pdfBytes(
			new Request('http://test', {
				method: 'POST',
				headers: {
					'content-type': 'application/pdf',
					'content-length': String(chunks.join('').length),
				},
				body,
				duplex: 'half',
			} as RequestInit),
		),
	).not.toBeNull();
});
test('work keys are scoped to case, bundle and content', () => {
	expect(bundleObjectKey('case-a', 'bundle-a', 'a'.repeat(64))).toBe(
		`work/case-a/bundles/bundle-a/${'a'.repeat(64)}.pdf`,
	);
	expect(() => bundleObjectKey('../case', 'bundle', 'a'.repeat(64))).toThrow();
});
