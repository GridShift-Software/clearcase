import { createHash } from 'node:crypto';
export const MAX_PDF_BYTES = 64 * 1024 * 1024;
export function bundleObjectKey(
	caseId: string,
	bundleId: string,
	sha256: string,
) {
	if (
		!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(caseId) ||
		!/^[A-Za-z0-9_-]{1,64}$/.test(bundleId) ||
		!/^[a-f0-9]{64}$/.test(sha256)
	)
		throw new Error('Invalid bundle key');
	return `work/${caseId}/bundles/${bundleId}/${sha256}.pdf`;
}
export function pdfDigest(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}
export async function pdfBytes(
	request: Request,
): Promise<Uint8Array<ArrayBuffer> | null> {
	const rawLength = request.headers.get('content-length');
	if (!rawLength || !/^[0-9]+$/.test(rawLength)) return null;
	const length = Number(rawLength);
	if (
		!Number.isSafeInteger(length) ||
		length < 8 ||
		length > MAX_PDF_BYTES ||
		request.headers.get('content-type') !== 'application/pdf'
	)
		return null;
	const reader = request.body?.getReader();
	if (!reader) return null;
	const magic = [37, 80, 68, 70, 45];
	let bytes: Uint8Array<ArrayBuffer> | null = null,
		offset = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value.length > length - offset) {
				await reader.cancel();
				return null;
			}
			for (let i = 0; i < value.length && offset + i < magic.length; i++) {
				if (value[i] !== magic[offset + i]) {
					await reader.cancel();
					return null;
				}
			}
			bytes ??= new Uint8Array(length);
			bytes.set(value, offset);
			offset += value.length;
		}
		if (
			!bytes ||
			offset !== length ||
			!new TextDecoder().decode(bytes.subarray(-1024)).includes('%%EOF')
		)
			return null;
		return bytes;
	} finally {
		reader.releaseLock();
	}
}
