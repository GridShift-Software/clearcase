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
export async function pdfForm(
	request: Request,
): Promise<{ form: FormData; bytes: Uint8Array } | null> {
	if (Number(request.headers.get('content-length')) > MAX_PDF_BYTES + 65536)
		return null;
	// Count while reading as well: a missing or dishonest Content-Length must not bypass the cap.
	const reader = request.body?.getReader();
	if (!reader) return null;
	const chunks: Uint8Array[] = [];
	let length = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		length += value.length;
		if (length > MAX_PDF_BYTES + 65536) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	const body = new Uint8Array(length);
	let offset = 0;
	for (const c of chunks) {
		body.set(c, offset);
		offset += c.length;
	}
	let form: FormData;
	try {
		form = await new Response(body, {
			headers: { 'content-type': request.headers.get('content-type') ?? '' },
		}).formData();
	} catch {
		return null;
	}
	const file = form.get('pdf');
	if (!(file instanceof Blob) || file.size > MAX_PDF_BYTES || file.size < 8)
		return null;
	const bytes = new Uint8Array(await file.arrayBuffer());
	if (
		new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-' ||
		!new TextDecoder().decode(bytes.subarray(-1024)).includes('%%EOF')
	)
		return null;
	return { form, bytes };
}
export const pdfBytes = async (request: Request) =>
	(await pdfForm(request))?.bytes ?? null;
