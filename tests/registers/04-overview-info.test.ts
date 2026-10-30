// Ticket 04: the overview and Information Required loaders split into a pure part (the version alone) and a merge part
// (notes, the previous version and the overview slots; the saved checks). merge(pure, no user work) equals load, and load
// with user work is what it was before the split. Synthetic case only; every value is invented.
process.env.TZ = 'UTC';
process.env.CLEARCASE_FIXED_NOW = '2026-10-08T09:00:00Z';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootCase, type Booted, type J } from './04-harness';

let b: Booted;
const routes: Record<string, unknown> = {};
beforeAll(async () => {
	b = await bootCase('04-overview');
	routes.overview = await import('../../src/routes/v/[vid]/overview/+page.server');
	routes.info = await import('../../src/routes/v/[vid]/analysis/info_required_tab/+page.server');
}, 180_000);
afterAll(() => b?.stop());

const split = async () => ({
	overview: { pure: (await import('../../src/lib/views/overview/pure.server')).overviewPure, merge: (await import('../../src/lib/views/overview/merge')).overviewMerge },
	info: { pure: (await import('../../src/lib/views/payloads/info-required.server')).infoRequiredPure, merge: (await import('../../src/lib/views/payloads/info-required')).infoRequiredMerge },
});
const slots = async () => {
	const { slotStates } = await import('../../src/lib/local-case/overview-widgets.server');
	const layout = (await import('../../src/routes/v/[vid]/+layout.server')) as unknown as { load: (e: unknown) => J };
	const { version } = layout.load({ params: { vid: b.rv } });
	return slotStates({ app: b.lc, caseId: b.caseId, caseName: version.caseName, resultsVersion: b.rv });
};
const INFO = 'info-required';
const EMPTY_NOTES = { total: 0, here: 0, exact: 0, ambiguous: 0, missing: 0, unanchored: 0, byRef: [], detached: [] };

describe('overview and info_required: pure and merge', () => {
	it('merge(pure, no user work) equals load', async () => {
		const s = await split();
		const o = await b.load(routes.overview);
		expect(o.notes).toEqual(EMPTY_NOTES);
		expect(o.previous).toBeNull();
		expect(s.overview.merge(s.overview.pure(b.input()), { notes: EMPTY_NOTES, previous: null, slots: await slots() })).toEqual(o);
		expect(s.info.merge(s.info.pure(b.input()), { rows: [] })).toEqual(await b.load(routes.info));
	});

	it('the shards hold no user work', async () => {
		const s = await split();
		const o = s.overview.pure(b.input()) as J;
		for (const k of ['notes', 'previous', 'slots']) expect(o).not.toHaveProperty(k);
		const i = s.info.pure(b.input()) as J;
		expect(Object.keys(i).sort()).toEqual(['heading', 'rows']);
		expect(i.rows.every((r: J) => r.done === false)).toBe(true);
	});

	it('with user work, load shows the notes and the saved checks as before', async () => {
		const { saveDone } = await import('../../src/lib/analysis/info-required.server');
		await b.lc.userWork.addNote(b.caseId, b.rv, 'OD-001', 'Invented note');
		const before = await b.load(routes.info);
		expect(await saveDone(b.lc.userWork, b.caseId, b.rv, before.rows, before.rows[0].key, true)).toBe(true);
		await b.lc.userWork.putRow(b.caseId, INFO, 'info:gone', { item: 'Removed item', done: true, resultsVersion: b.rv });
		await b.lc.userWork.putRow(b.caseId, INFO, 'info:undone', { item: 'Unticked item', done: false, resultsVersion: b.rv });

		const o = await b.load(routes.overview);
		expect([o.notes.total, o.notes.byRef]).toEqual([1, [{ ref: 'OD-001', n: 1, status: expect.any(String) }]]);
		const i = await b.load(routes.info);
		expect(i.rows.map((r: J) => [r.item, r.done])).toEqual([['Invented item', true]]);
		expect(i.detached).toBe(1);

		const s = await split();
		expect(s.overview.merge(s.overview.pure(b.input()), { notes: b.lc.userWork.summary(b.caseId, b.rv), previous: null, slots: await slots() })).toEqual(o);
		expect(s.info.merge(s.info.pure(b.input()), { rows: b.lc.userWork.listRows(b.caseId, INFO) })).toEqual(i);
	});
});
