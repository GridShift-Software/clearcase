// GRS-264: a saved bundle shows from the save's answer. The save is one POST and nothing else reaches the network or
// SvelteKit's invalidation; the answer's stored list replaces the page's custom bundles (name and stored-PDF link at
// once, the shipped ones kept), and a refused or lost save changes nothing and keeps the message the Builder shows.
import { describe, expect, it, vi } from 'vitest';
import type { Custom } from '../../src/lib/bundles/builder.ts';
import type { Bundle } from '../../src/lib/views/bundles/court.ts';
import { hrefOf } from '../../src/lib/views/bundles/links.ts';
import { assembledUrl, saveBundle, withStored, type BundleLists, type StoredBundle } from '../../src/lib/views/bundles/saved.ts';

const PATH = '/v/ver-1/bundles/court_bundle_tab';
const pdf = new Blob(['%PDF-1.4'], { type: 'application/pdf' });
const entry: Omit<Custom, 'no'> = {
	name: 'Synthetic bundle', pages: 3, indexPages: 1, filePages: 4, note: 'Built in this app. The saved PDF and item list are kept.',
	rows: [{ n: 1, key: '', desc: 'Invented item', pages: 3, from: 1, to: 3, parts: [{ rel: 'a.pdf', url: '', name: 'a.pdf', from: 1, to: 3 }] }],
};
const stored = (id: string, no: string, assembled = true): StoredBundle => ({ id, custom: { ...entry, no, name: `Bundle ${no}` }, assembled });
const shipped: Bundle = { no: '1', name: 'Shipped', title: '(1) Shipped', note: '', rows: [], pages: 0, indexPages: 0, file: '', indexFile: '' };
const loaded = (): BundleLists => ({ bundles: [shipped], links: [{ file: null, indexFile: null, rows: [] }], files: {}, downloads: {} });
const answer = (body: unknown, status = 200) => vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));

describe('a successful save', () => {
	it('is one POST of the PDF to the assembled endpoint, and answers with the stored list to show', async () => {
		const list = [stored('o1', 'C1')];
		const send = answer({ saved: true, id: 'o1', no: 'C1', bundles: list });
		const r = await saveBundle(send, PATH + '/', 'o1', pdf, entry);
		expect(send).toHaveBeenCalledTimes(1);
		const [url, init] = send.mock.calls[0]!;
		expect(url).toBe(PATH + '/assembled');
		expect(init?.method).toBe('POST');
		expect(init?.body).toBe(pdf);
		expect(r).toEqual({ ok: true, no: 'C1', bundles: list });
	});

	it('has no list to show when the answer carries none or a malformed one, which the page meets by reloading', async () => {
		for (const bundles of [undefined, 'x', [{ id: 'o1' }], [{ id: 7, custom: { ...entry, no: 'C1' } }]]) {
			const r = await saveBundle(answer({ saved: true, id: 'o1', no: 'C1', bundles }), PATH, 'o1', pdf, entry);
			expect(r).toEqual({ ok: true, no: 'C1', bundles: null });
		}
	});

	it('lists the saved name and the stored assembled PDF link without another load of the page data', () => {
		const before = loaded();
		const shown = withStored(before, [stored('o1', 'C1')], PATH);
		expect(before.bundles).toHaveLength(1); // the loaded data is not touched
		expect(shown.bundles.map((b) => [b.no, b.name, b.id])).toEqual([['1', 'Shipped', undefined], ['C1', 'Bundle C1', 'o1']]);
		expect(shown.links).toHaveLength(shown.bundles.length);
		expect(hrefOf('ver-1', shown.files, shown.links[1]!.file)).toBe(`${PATH}/assembled?id=o1`);
		expect(shown.downloads.o1).toBe(assembledUrl(PATH, 'o1'));
		expect(shown.bundles[1]!.rows).toHaveLength(1);
		expect(shown.links[1]!.rows).toHaveLength(1);
	});

	it('replaces the loaded custom bundles with the stored list, in its order, and keeps the shipped ones', () => {
		const old = withStored(loaded(), [stored('oa', 'C1'), stored('ob', 'C2')], PATH); // what the page loaded
		const shown = withStored(old, [stored('ob', 'C2'), stored('oc', 'C3', false)], PATH);
		expect(shown.bundles.map((b) => b.no)).toEqual(['1', 'C2', 'C3']);
		expect(Object.keys(shown.files)).toEqual(['ob']); // A is gone with its link; C has no stored PDF, so no link
		expect(shown.links.map((l) => l.file?.ref ?? null)).toEqual([null, 'ob', null]);
		expect(withStored(shown, [], PATH).bundles.map((b) => b.no)).toEqual(['1']);
	});
});

describe('a save that fails', () => {
	it('shows the endpoint\'s own message and has no list to show', async () => {
		const r = await saveBundle(answer({ message: 'Not saved: the bundle could not be read.' }, 400), PATH, 'o1', pdf, entry);
		expect(r).toEqual({ ok: false, kind: 'refused', message: 'Not saved: the bundle could not be read.' });
	});
	it('says Retry when the refusal carries no message', async () => {
		expect(await saveBundle(answer({}, 503), PATH, 'o1', pdf, entry)).toEqual({ ok: false, kind: 'refused', message: 'Not saved. Retry.' });
	});
	it('reports a lost upload and an unreadable answer the same way', async () => {
		const lost = await saveBundle(vi.fn<typeof fetch>(async () => { throw new TypeError('network'); }), PATH, 'o1', pdf, entry);
		const html = await saveBundle(vi.fn<typeof fetch>(async () => new Response('<html>', { status: 502 })), PATH, 'o1', pdf, entry);
		for (const r of [lost, html]) expect(r).toEqual({ ok: false, kind: 'failed', message: 'Not saved: the upload failed. Retry.' });
	});
	it('refuses an item list too large for the header before any request is sent', async () => {
		const send = answer({ saved: true });
		const huge = { ...entry, rows: Array.from({ length: 2000 }, (_, k) => ({ ...entry.rows[0]!, n: k + 1, desc: 'x'.repeat(40) })) };
		expect(await saveBundle(send, PATH, 'o1', pdf, huge)).toMatchObject({ ok: false, kind: 'failed' });
		expect(send).not.toHaveBeenCalled();
	});
	it('carries no list in any failed result, so the page keeps the list it has', async () => {
		for (const r of [await saveBundle(answer({ message: 'no' }, 400), PATH, 'o1', pdf, entry), await saveBundle(vi.fn<typeof fetch>(async () => { throw new Error('x'); }), PATH, 'o1', pdf, entry)]) {
			expect(r.ok).toBe(false);
			expect('bundles' in r).toBe(false);
		}
	});
});
