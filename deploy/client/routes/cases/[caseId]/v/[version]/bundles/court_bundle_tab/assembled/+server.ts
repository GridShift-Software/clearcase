import { env } from 'cloudflare:workers';
import { error, json, type RequestEvent } from '@sveltejs/kit';
import { publishedVersion } from '$lib/views/hosted/payloads.server';
import { refuse } from '$lib/server/runtime/hosted/http';
import { cloudBindings } from '$lib/storage/cloud/bindings';
import {
	pdfBytes,
	pdfDigest,
	bundleObjectKey,
	writeBundlePdf,
} from '$lib/views/bundles/assembled';
import { uploadBundle } from '$lib/views/bundles/upload';
import { customOf } from '$lib/bundles/builder';
import {
	bundleStore,
	customRows,
	CUSTOM_TABLE,
} from '$lib/views/bundles/store.hosted';
/** A failed object write, told apart from the row's own refusals. */
const OBJECT_FAILED = new Error('bundle PDF not stored');
export async function POST({ locals, params, request }: RequestEvent) {
	const total = performance.now();
	// The version check and the write authorization are independent reads, so they run together; both must pass before
	// the body is read, and a version refusal is reported first, as when they ran one after the other.
	const [version, authorized] = await Promise.allSettled([
		publishedVersion(locals, params),
		locals.identity.authorize({
			caseId: String(params.caseId ?? ''),
			operation: 'write-user-work',
		}),
	]);
	if (version.status === 'rejected') throw version.reason;
	if (authorized.status === 'rejected') refuse(authorized.reason, 'write');
	const scope = version.value;
	const metadata = uploadBundle(request);
	if (!metadata)
		return json({ message: 'Invalid bundle metadata.' }, { status: 400 });
	const { id, value } = metadata;

	const c = customOf(
		value && typeof value === 'object' ? { ...value, no: 'C' } : null,
	);
	if (!c || c.rows.length > 5000)
		return json({ message: 'Invalid bundle.' }, { status: 400 });
	const binding = cloudBindings(env);
	if (!binding) error(503, 'Storage unavailable.');
	const bytes = await pdfBytes(request);
	if (!bytes)
		return json(
			{ message: 'Upload a PDF with Content-Length, no larger than 64 MiB.' },
			{ status: 400 },
		);
	const sha256 = pdfDigest(bytes),
		storedAt = performance.now();
	let writeAt = storedAt;
	// The object write and the row's read, authorization and preparation run side by side; the row commits only once
	// the object is stored, so a saved row never names a missing PDF.
	const stored = writeBundlePdf(
		binding.bucket,
		bundleObjectKey(scope.caseId, id, sha256),
		bytes,
		sha256,
	).then((outcome) => {
		writeAt = performance.now();
		if (outcome !== 'written' && outcome !== 'present') throw OBJECT_FAILED;
	});
	stored.catch(() => undefined); // observed by the commit, or below when the row is refused first
	let no: string;
	try {
		no = await bundleStore(locals, scope).putCustom(
			id,
			c,
			[],
			{ sha256, bytes: bytes.length },
			stored,
		);
	} catch (e) {
		await stored.catch(() => undefined);
		if (e === OBJECT_FAILED) error(503, 'The PDF could not be stored. Retry.');
		refuse(e, 'write');
	}
	const end = performance.now();
	return json(
		{ saved: true, id, no },
		{
			headers: {
				// userwork is the commit left after the object write; the rest of the row's work ran beside it.
				'server-timing': `object;dur=${(writeAt - storedAt).toFixed(1)}, userwork;dur=${(end - writeAt).toFixed(1)}, total;dur=${(end - total).toFixed(1)}`,
			},
		},
	);
}
export async function GET({ locals, params, url }: RequestEvent) {
	const scope = await publishedVersion(locals, params),
		id = url.searchParams.get('id') ?? '';
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) error(404, 'Not found.');
	const rows = await bundleStore(locals, scope)
		.table(CUSTOM_TABLE)
		.catch(refuse);
	const c = customRows(rows).find((r) => r.id === id);
	if (!c?.assembledSha256) error(404, 'Not found.');
	const binding = cloudBindings(env);
	if (!binding) error(503, 'Storage unavailable.');
	const object = await binding.bucket.get(
		bundleObjectKey(scope.caseId, id, c.assembledSha256),
	);
	if (
		!object ||
		object.size !== c.bytes ||
		!('body' in object) ||
		!(object.body instanceof ReadableStream)
	)
		error(503, 'The saved PDF is unavailable.');
	return new Response(object.body, {
		headers: {
			'content-type': 'application/pdf',
			'content-length': String(c.bytes),
			'content-disposition': `attachment; filename="${c.name.replace(/[^A-Za-z0-9 _-]/g, '').slice(0, 60) || 'Bundle'}.pdf"`,
			'cache-control': 'private, no-store',
			'x-content-type-options': 'nosniff',
		},
	});
}
