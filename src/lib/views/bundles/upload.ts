export const MAX_BUNDLE_HEADER = 24 * 1024;
export function bundleUploadHeaders(
	id: string,
	bundle: unknown,
): Record<string, string> {
	const encoded = encodeURIComponent(JSON.stringify(bundle));
	if (encoded.length > MAX_BUNDLE_HEADER)
		throw new Error(
			'The bundle item list is too large to save (24 KiB encoded limit).',
		);
	return {
		'content-type': 'application/pdf',
		'x-bundle-id': id,
		'x-bundle': encoded,
	};
}
export function uploadBundle(
	request: Request,
): { id: string; value: unknown } | null {
	const id = request.headers.get('x-bundle-id') ?? '',
		encoded = request.headers.get('x-bundle') ?? '';
	if (
		!/^[A-Za-z0-9_-]{1,64}$/.test(id) ||
		!encoded ||
		encoded.length > MAX_BUNDLE_HEADER
	)
		return null;
	try {
		return { id, value: JSON.parse(decodeURIComponent(encoded)) };
	} catch {
		return null;
	}
}
