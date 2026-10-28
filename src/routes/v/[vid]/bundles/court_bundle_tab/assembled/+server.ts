import { error, json } from '@sveltejs/kit';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { app } from '$lib/local-case/app.server';
import {
	pdfBytes,
	pdfDigest,
	bundleObjectKey,
} from '$lib/views/bundles/assembled';
import { uploadBundle } from '$lib/views/bundles/upload';
import { customOf } from '$lib/bundles/builder';
import { readCustom, saveCustom } from '$lib/views/bundles/store.server';
import type { RequestHandler } from './$types';
export const POST: RequestHandler = async ({ params, request }) => {
	const a = app(),
		c = a.store.getVersion(params.vid)?.case_id;
	if (!c) error(404, 'Not found.');
	const metadata = uploadBundle(request);
	if (!metadata) error(400, 'Invalid bundle metadata.');
	const { id, value } = metadata;
	const bytes = await pdfBytes(request);
	if (!bytes)
		return json(
			{ message: 'Upload a PDF with Content-Length, no larger than 64 MiB.' },
			{ status: 400 },
		);
	const entry = customOf(
		value && typeof value === 'object' ? { ...value, no: 'C' } : null,
	);
	if (!entry) error(400, 'Invalid bundle.');
	const sha256 = pdfDigest(bytes),
		file = path.join(a.config.dataDir, bundleObjectKey(c, id, sha256));
	await mkdir(path.dirname(file), { recursive: true });
	try {
		await writeFile(file, bytes, { flag: 'wx', mode: 0o600 });
	} catch (e) {
		if (!(e instanceof Error) || !('code' in e) || e.code !== 'EEXIST') throw e;
	}
	await writeFile(
		path.join(path.dirname(file), 'assembled.json'),
		JSON.stringify({ sha256, bytes: bytes.length }),
		{ mode: 0o600 },
	);
	const no = await saveCustom(c, id, entry, []);
	return json({ saved: true, id, no });
};
export const GET: RequestHandler = async ({ params, url }) => {
	const a = app(),
		c = a.store.getVersion(params.vid)?.case_id;
	if (!c) error(404, 'Not found.');
	const saved = (await readCustom(c)).find(
		(r) => r.id === url.searchParams.get('id'),
	);
	if (!saved?.assembledSha256) error(404, 'Not found.');
	const bytes = await readFile(
		path.join(
			a.config.dataDir,
			bundleObjectKey(c, saved.id, saved.assembledSha256),
		),
	);
	return new Response(bytes, {
		headers: {
			'content-type': 'application/pdf',
			'content-disposition': 'attachment; filename="Bundle.pdf"',
			'cache-control': 'private, no-store',
		},
	});
};
