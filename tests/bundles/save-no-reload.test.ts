// GRS-264: a saved bundle shows from the save's answer. The save is one POST and nothing else reaches the network or
// SvelteKit's invalidation; the page lists the bundle with its name and stored-PDF link at once, keeps it past a
// later load that carries it, and a refused or lost save adds nothing and keeps the message the Builder shows.
import { describe, expect, it, vi } from 'vitest';
import type { Custom } from '../../src/lib/bundles/builder.ts';
import type { Bundle } from '../../src/lib/views/bundles/court.ts';
import { hrefOf } from '../../src/lib/views/bundles/links.ts';
import { assembledUrl, saveBundle, withSaved, type BundleLists } from '../../src/lib/views/bundles/saved.ts';

const PATH = '/v/ver-1/bundles/court_bundle_tab';
const pdf = new Blob(['%PDF-1.4'], { type: 'application/pdf' });
const entry: Omit<Custom, 'no'> = {
	name: 'Synthetic bundle', pages: 3, indexPages: 1, filePages: 4, note: 'Built in this app. The saved PDF and item list are kept.',
	rows: [{ n: 1, key: '', desc: 'Invented item', pages: 3, from: 1, to: 3, parts: [{ rel: 'a.pdf', url: '', name: 'a.pdf', from: 1, to: 3 }] }],
};
const shipped: Bundle = { no: '1', name: 'Shipped', title: '(1) Shipped', note: '', rows: [], pages: 0, indexPages: 0, file: '', indexFile: '' };
const loaded = (): BundleLists => ({ bundles: [shipped], links: [{ file: null, indexFile: null, rows: [] }], files: {}, downloads: {} });
const answer = (body: unknown, status = 200) => vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status }));

describe('a successful save', () => {
	it('is one POST of the PDF to the assembled endpoint, and answers with the bundle to show', async () => {
		const send = answer({ saved: true, id: 'o1', no: 'C1' });
		const r = await saveBundle(send, PATH + '/', 'o1', pdf, entry);
		expect(send).toHaveBeenCalledTimes(1);
		const [url, init] = send.mock.calls[0]!;
		expect(url).toBe(PATH + '/assembled');
		expect(init?.method).toBe('POST');
		expect(init?.body).toBe(pdf);
		expect(r).toEqual({ ok: true, saved: { id: 'o1', custom: { ...entry, no: 'C1' } } });
	});

	it('lists the saved name and the stored assembled PDF link without another load of the page data', async () => {
		const r = await saveBundle(answer({ saved: true, id: 'o1', no: 'C1' }), PATH, 'o1', pdf, entry);
		if (!r.ok) throw new Error('save failed');
		const before = loaded();
		const shown = withSaved(before, [r.saved], PATH);
		expect(before.bundles).toHaveLength(1); // the loaded data is not touched
		expect(shown.bundles.map((b) => [b.no, b.name, b.id])).toEqual([['1', 'Shipped', undefined], ['C1', 'Synthetic bundle', 'o1']]);
		expect(shown.links).toHaveLength(shown.bundles.length);
		const link = shown.links[1]!.file;
		expect(hrefOf('ver-1', shown.files, link)).toBe(`${PATH}/assembled?id=o1`);
		expect(shown.downloads.o1).toBe(assembledUrl(PATH, 'o1'));
		expect(shown.bundles[1]!.rows).toHaveLength(1);
		expect(shown.links[1]!.rows).toHaveLength(1);
	});

	it('gives way to a load that carries the bundle, and shows nothing twice', () => {
		const saved = { id: 'o1', custom: { ...entry, no: 'C1' } };
		const after: BundleLists = { ...loaded(), bundles: [shipped, { ...shipped, no: 'C1', id: 'o1' }], links: [loaded().links[0]!, loaded().links[0]!] };
		expect(withSaved(after, [saved], PATH)).toBe(after);
		expect(withSaved(loaded(), [], PATH).bundles).toHaveLength(1);
	});

	it('keeps several saves in the order saved', () => {
		const a = { id: 'oa', custom: { ...entry, no: 'C1', name: 'A' } }, b = { id: 'ob', custom: { ...entry, no: 'C2', name: 'B' } };
		expect(withSaved(loaded(), [a, b], PATH).bundles.map((x) => x.name)).toEqual(['Shipped', 'A', 'B']);
	});
});

describe('a save that fails', () => {
	it('shows the endpoint\'s own message and adds nothing', async () => {
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
	it('leaves the page lists as loaded, since no bundle is added', async () => {
		const r = await saveBundle(answer({ message: 'no' }, 400), PATH, 'o1', pdf, entry);
		const before = loaded();
		expect(withSaved(before, r.ok ? [r.saved] : [], PATH)).toBe(before);
	});
});
