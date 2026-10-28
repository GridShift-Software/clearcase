import { expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fixture, CASE, RV1 } from '../hosted-foundation/user-work/helpers';
import { MemoryR2 } from '../hosted-foundation/storage/doubles';
import {
	customRows,
	bundleStore,
	CUSTOM_TABLE,
} from '../../src/lib/views/bundles/store.hosted';
import { contractError } from '../../src/lib/server/runtime/errors';
import type { RequestServices } from '../../src/lib/server/runtime/contracts';
import type { RequestEvent } from '@sveltejs/kit';
const workers = vi.hoisted(() => ({ env: {} as Record<string, unknown> }));
vi.mock('cloudflare:workers', () => workers);
import {
	POST,
	GET,
} from '../../deploy/client/routes/cases/[caseId]/v/[version]/bundles/court_bundle_tab/assembled/+server';
function world() {
	const f = fixture();
	f.db.exec(
		readFileSync(
			'src/lib/user-work/hosted/migrations/0002_bundle_tables.sql',
			'utf8',
		),
	);
	const bucket = new MemoryR2();
	let gets = 0,
		publications = 0;
	const bytes = new TextEncoder().encode('%PDF-1.7\nsynthetic test\n%%EOF');
	workers.env = {
		DB: { prepare() {}, batch() {} },
		BUCKET: {
			head: bucket.head.bind(bucket),
			put: bucket.put.bind(bucket),
			get: async (key: string) => {
				gets++;
				const value = await bucket.get(key);
				if (!value) return null;
				const data = await value.arrayBuffer();
				return {
					...value,
					body: new ReadableStream({
						start(c) {
							c.enqueue(new Uint8Array(data));
							c.close();
						},
					}),
					arrayBuffer() {
						throw new Error('GET must stream');
					},
				};
			},
		},
	};
	const work = f.make();
	const locals = {
		userWork: work,
		identity: f.auth.identity(),
		store: {
			publication: async () => {
				publications++;
				return {
					versionId: RV1,
					shardManifestSha256: 'a'.repeat(64),
					shards: {},
				};
			},
		},
	} as unknown as RequestServices;
	const params = { caseId: CASE, version: RV1 };
	return { f, locals, params, bytes, counts: () => ({ gets, publications }) };
}
test('POST saves bytes and metadata; a new GET streams identical bytes with attachment disposition', async () => {
	const w = world();
	try {
		const form = new FormData();
		form.set('id', 'bundle-test');
		form.set(
			'pdf',
			new Blob([w.bytes], { type: 'application/pdf' }),
			'bundle.pdf',
		);
		form.set(
			'bundle',
			JSON.stringify({
				name: 'Synthetic bundle',
				pages: 3,
				indexPages: 1,
				filePages: 2,
				rows: [],
				note: '',
			}),
		);
		const response = await POST({
			locals: w.locals,
			params: w.params,
			request: new Request('https://synthetic.invalid/assembled', {
				method: 'POST',
				body: form,
			}),
		} as unknown as RequestEvent);
		expect(response.status).toBe(200);
		expect(response.headers.get('server-timing')).toContain('userwork;dur=');
		const rows = customRows(
			await bundleStore(w.locals, { caseId: CASE, resultsVersion: RV1 }).table(
				CUSTOM_TABLE,
			),
		);
		expect(rows).toMatchObject([{ id: 'bundle-test', bytes: w.bytes.length }]);
		const downloaded = await GET({
			locals: { ...w.locals },
			params: w.params,
			url: new URL('https://synthetic.invalid/assembled?id=bundle-test'),
		} as unknown as RequestEvent);
		expect(downloaded.headers.get('content-disposition')).toContain(
			'attachment;',
		);
		expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(w.bytes);
		expect(w.counts().gets).toBe(1);
	} finally {
		w.f.db.close();
	}
});
test('a case without a grant cannot read a saved PDF by id; no user work or bucket read occurs', async () => {
	const w = world();
	try {
		const denied = {
			...w.locals,
			store: {
				...w.locals.store,
				publication: async () => {
					throw contractError('forbidden');
				},
			},
			userWork: new Proxy(w.locals.userWork, {
				get() {
					throw new Error('must deny before work lookup');
				},
			}),
		};
		await expect(
			GET({
				locals: denied,
				params: w.params,
				url: new URL('https://synthetic.invalid/assembled?id=bundle-test'),
			} as unknown as RequestEvent),
		).rejects.toMatchObject({ status: 404 });
		expect(w.counts().gets).toBe(0);
	} finally {
		w.f.db.close();
	}
});
test('a viewer cannot upload even a valid PDF', async () => {
	const w = world();
	try {
		const identity = w.f.auth.identity('viewer');
		await expect(
			POST({
				locals: { ...w.locals, identity },
				params: w.params,
				request: new Request('https://synthetic.invalid/assembled', {
					method: 'POST',
					body: 'bad',
				}),
			} as unknown as RequestEvent),
		).rejects.toMatchObject({ status: 403 });
		expect(w.counts().gets).toBe(0);
	} finally {
		w.f.db.close();
	}
});
