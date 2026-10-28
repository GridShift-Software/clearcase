import { expect, test } from 'vitest';
import {
	pdfBytes,
	MAX_PDF_BYTES,
	bundleObjectKey,
} from '../../src/lib/views/bundles/assembled';
test('accepts PDF bytes and refuses renamed input and oversized uploads before reading', async () => {
	expect(
		await pdfBytes(new Request('http://test', { method: 'POST', body: 'no' })),
	).toBeNull();
	const data = new FormData();
	data.set(
		'pdf',
		new Blob(['%PDF-1.7\nsynthetic\n%%EOF'], { type: 'application/pdf' }),
		'a.pdf',
	);
	expect(
		await pdfBytes(new Request('http://test', { method: 'POST', body: data })),
	).toEqual(new TextEncoder().encode('%PDF-1.7\nsynthetic\n%%EOF'));
	data.set(
		'pdf',
		new Blob(['not a pdf'], { type: 'application/pdf' }),
		'a.pdf',
	);
	expect(
		await pdfBytes(new Request('http://test', { method: 'POST', body: data })),
	).toBeNull();
	expect(
		await pdfBytes(
			new Request('http://test', {
				method: 'POST',
				headers: { 'content-length': String(MAX_PDF_BYTES + 100000) },
				body: 'no',
			}),
		),
	).toBeNull();
});
test('work keys are scoped to case, bundle and content', () => {
	expect(bundleObjectKey('case-a', 'bundle-a', 'a'.repeat(64))).toBe(
		`work/case-a/bundles/bundle-a/${'a'.repeat(64)}.pdf`,
	);
	expect(() => bundleObjectKey('../case', 'bundle', 'a'.repeat(64))).toThrow();
});
