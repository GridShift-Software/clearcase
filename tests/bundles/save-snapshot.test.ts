// GRS-264 fix round (#196 review): the hosted save endpoint answers with the stored custom-bundle list, read after its
// own write, and the page replaces its custom bundles with it. So saving one output twice lists it once, a bundle
// deleted in another tab stays gone through a later save, and another tab's new bundle appears in stored order.
import { expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type { RequestEvent } from '@sveltejs/kit';
import { fixture, CASE, RV1 } from '../hosted-foundation/user-work/helpers';
import { MemoryR2 } from '../hosted-foundation/storage/doubles';
import { bundleStore } from '../../src/lib/views/bundles/store.hosted';
import type { RequestServices } from '../../src/lib/server/runtime/contracts';
import { toBundle } from '../../src/lib/bundles/builder';
import type { Bundle } from '../../src/lib/views/bundles/court';
import { bundleUploadHeaders } from '../../src/lib/views/bundles/upload';
import { withStored, type BundleLists, type StoredBundle } from '../../src/lib/views/bundles/saved';
const workers = vi.hoisted(() => ({ env: {} as Record<string, unknown> }));
vi.mock('cloudflare:workers', () => workers);
import { POST } from '../../deploy/client/routes/cases/[caseId]/v/[version]/bundles/court_bundle_tab/assembled/+server';

const PATH = `/cases/${CASE}/v/${RV1}/bundles/court_bundle_tab`;
const scope = { caseId: CASE, resultsVersion: RV1 };
const shipped: Bundle = { no: '1', name: 'Shipped', title: '(1) Shipped', note: '', rows: [], pages: 0, indexPages: 0, file: '', indexFile: '' };
const entry = (name: string) => ({ name, pages: 3, indexPages: 1, filePages: 2, note: '', rows: [{ n: 1, key: '', desc: `${name} item`, pages: 3, from: 1, to: 3, parts: [{ rel: 'a.pdf', url: '', name: 'a.pdf', from: 1, to: 3 }] }] });
const custom = (name: string) => ({ no: 'C', ...entry(name) });

function world() {
	const f = fixture();
	f.db.exec(readFileSync('src/lib/user-work/hosted/migrations/0002_bundle_tables.sql', 'utf8'));
	const bucket = new MemoryR2();
	workers.env = { DB: { prepare() {}, batch() {} }, BUCKET: { head: bucket.head.bind(bucket), put: bucket.put.bind(bucket), get: bucket.get.bind(bucket) } };
	const locals = {
		userWork: f.make(), identity: f.auth.identity(),
		store: { publication: async () => ({ versionId: RV1, shardManifestSha256: 'a'.repeat(64), shards: {} }) },
	} as unknown as RequestServices;
	const store = bundleStore(locals, scope);
	const bytes = new TextEncoder().encode('%PDF-1.7\nsynthetic test\n%%EOF');
	/** The Builder's save of output `id`. */
	const save = async (id: string, name: string) => {
		const response = await POST({
			locals, params: { caseId: CASE, version: RV1 },
			request: new Request('https://synthetic.invalid/assembled', { method: 'POST', body: bytes, headers: { ...bundleUploadHeaders(id, entry(name)), 'content-length': String(bytes.length) } }),
		} as unknown as RequestEvent);
		return { status: response.status, body: await response.json() as { saved: boolean; id: string; no: string; bundles: StoredBundle[] } };
	};
	/** What the page holds from its load: the shipped bundle and the custom bundles stored then. */
	const loadedBy = async (): Promise<BundleLists> => {
		const { customRows } = await import('../../src/lib/views/bundles/store.hosted');
		const rows = customRows(await store.table('bundles_custom'));
		return {
			bundles: [shipped, ...rows.map((c) => toBundle(c, c.id))],
			links: [{ file: null, indexFile: null, rows: [] }, ...rows.map((c) => ({ file: c.assembledSha256 ? { ref: c.id, page: null } : null, indexFile: null, rows: [] }))],
			files: Object.fromEntries(rows.filter((c) => c.assembledSha256).map((c) => [c.id, `${PATH}/assembled?id=${c.id}`])),
			downloads: {},
		};
	};
	return { f, store, save, loadedBy, close: () => f.db.close() };
}
const custom_ = (l: BundleLists) => l.bundles.filter((b) => b.id !== undefined);

test('saving the same output twice stores and lists one bundle', async () => {
	const w = world();
	try {
		const loaded = await w.loadedBy();
		const first = await w.save('o1', 'Twice'), second = await w.save('o1', 'Twice');
		expect([first.status, second.status]).toEqual([200, 200]);
		expect(second.body.no).toBe(first.body.no);
		expect(second.body.bundles.map((b) => b.id)).toEqual(['o1']);
		const shown = withStored(loaded, second.body.bundles, PATH);
		expect(custom_(shown).map((b) => [b.id, b.no, b.name])).toEqual([['o1', 'C1', 'Twice']]);
		expect(shown.links).toHaveLength(shown.bundles.length);
	} finally { w.close(); }
});

test('a bundle deleted in another tab stays gone through a later save', async () => {
	const w = world();
	try {
		await w.store.putCustom('oa', custom('A'), []);
		await w.store.putCustom('ob', custom('B'), []);
		const loaded = await w.loadedBy(); // this tab opened with A and B
		expect(custom_(loaded).map((b) => b.id)).toEqual(['oa', 'ob']);
		await w.store.deleteCustom('oa'); // the other tab removes A
		const saved = await w.save('oc', 'C');
		const shown = withStored(loaded, saved.body.bundles, PATH);
		expect(custom_(shown).map((b) => b.id)).toEqual(['ob', 'oc']);
		expect(Object.keys(shown.files)).not.toContain('oa');
		// a later save, from the same stale page data, still does not bring A back
		const later = await w.save('od', 'D');
		expect(custom_(withStored(loaded, later.body.bundles, PATH)).map((b) => b.id)).toEqual(['ob', 'oc', 'od']);
	} finally { w.close(); }
});

test('another tab\'s new bundle appears after a save, in stored order, with the stored PDF links', async () => {
	const w = world();
	try {
		await w.store.putCustom('oa', custom('A'), []);
		const loaded = await w.loadedBy();
		await w.store.putCustom('ox', custom('X'), []); // created in the other tab after this page loaded
		const saved = await w.save('oc', 'C');
		expect(saved.body.bundles.map((b) => [b.id, b.custom.no, b.assembled])).toEqual([['oa', 'C1', false], ['ox', 'C2', false], ['oc', 'C3', true]]);
		const shown = withStored(loaded, saved.body.bundles, PATH);
		expect(shown.bundles.map((b) => b.no)).toEqual(['1', 'C1', 'C2', 'C3']);
		expect(Object.keys(shown.files)).toEqual(['oc']); // only a stored PDF has a link
		expect(shown.links.map((l) => l.file?.ref ?? null)).toEqual([null, null, null, 'oc']);
		expect(saved.body.bundles[2]!.custom.rows).toHaveLength(1); // the items of every listed bundle, for its tabs
		expect(saved.body.bundles.every((b) => typeof b.version === 'string' && b.version.length > 0)).toBe(true);
	} finally { w.close(); }
});
