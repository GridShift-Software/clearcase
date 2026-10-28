import { env } from 'cloudflare:workers';
import { error, json, type RequestEvent } from '@sveltejs/kit';
import { publishedVersion } from '$lib/views/hosted/payloads.server';
import { refuse } from '$lib/server/runtime/hosted/http';
import { cloudBindings } from '$lib/storage/cloud/bindings';
import { writeOnce } from '$lib/storage/cloud/objects';
import { digest } from '$lib/server/runtime/data';
import { pdfForm, bundleObjectKey } from '$lib/views/bundles/assembled';
import { customOf } from '$lib/bundles/builder';
import {
	bundleStore,
	customRows,
	CUSTOM_TABLE,
} from '$lib/views/bundles/store.hosted';
export async function POST({ locals, params, request }: RequestEvent) {
	const total = performance.now(),
		scope = await publishedVersion(locals, params);
	await locals.identity
		.authorize({ caseId: scope.caseId, operation: 'write-user-work' })
		.catch((e) => refuse(e, 'write'));
	const data = await pdfForm(request);
	if (!data)
		return json(
			{ message: 'Upload a PDF no larger than 64 MiB.' },
			{ status: 400 },
		);
	const id = String(data.form.get('id') ?? '');
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(id))
		return json({ message: 'Invalid bundle id.' }, { status: 400 });
	let value: unknown;
	try {
		value = JSON.parse(String(data.form.get('bundle') ?? ''));
	} catch {
		return json({ message: 'Invalid bundle.' }, { status: 400 });
	}
	const c = customOf(
		value && typeof value === 'object' ? { ...value, no: 'C' } : null,
	);
	if (!c || c.rows.length > 5000)
		return json({ message: 'Invalid bundle.' }, { status: 400 });
	const binding = cloudBindings(env);
	if (!binding) error(503, 'Storage unavailable.');
	const sha256 = await digest(data.bytes),
		storedAt = performance.now();
	const outcome = await writeOnce(
		binding.bucket,
		bundleObjectKey(scope.caseId, id, sha256),
		data.bytes,
		sha256,
	);
	if (outcome !== 'written' && outcome !== 'present')
		error(503, 'The PDF could not be stored. Retry.');
	const writeAt = performance.now();
	// Custom numbering is derived from saved custom rows (C1, C2, …); shipped numbers are numeric.
	const no = await bundleStore(locals, scope)
		.putCustom(id, c, [], { sha256, bytes: data.bytes.length })
		.catch((e) => refuse(e, 'write'));
	const end = performance.now();
	return json(
		{ saved: true, id, no },
		{
			headers: {
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
