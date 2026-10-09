// The overview widget-slot registry: owners fill only their own declared slots from their own subtree; unfilled
// slots name their owner; a failing widget loader marks its slot and never breaks the overview.
import { describe, expect, it } from 'vitest';
import { loadersFrom, slotStates } from '../local-case/overview-widgets.server.ts';
import { collect, OVERVIEW_SLOTS } from './overview-slots.ts';
import { widgets } from './overview-widgets.ts';

const ctx = { app: null, caseId: 'c', caseName: 'Case', resultsVersion: 'sha256:' + '0'.repeat(64) };

describe('overview slots', () => {
	it('declares the GRS-17 deadline and time summaries and the GRS-20 freshness stamp', () => {
		expect(OVERVIEW_SLOTS.map((s) => [s.id, s.linear, s.category])).toEqual([['deadlines', 'GRS-17', 'registers'], ['unbilled-time', 'GRS-17', 'registers'], ['rescan-freshness', 'GRS-20', 'system']]);
		expect(widgets.size).toBe(0); // nothing fills a slot in the pilot
	});
	it('shows every slot as unavailable until its owner fills it', async () => {
		const s = await slotStates(ctx);
		expect(s.map((x) => [x.slot.id, x.status])).toEqual([['deadlines', 'unavailable'], ['unbilled-time', 'unavailable'], ['rescan-freshness', 'unavailable']]);
	});
	it('runs owners loaders and isolates a failure to its slot', async () => {
		const loaders = loadersFrom({
			'/src/lib/views/registers/overview-widgets.server.ts': { loaders: [{ slot: 'deadlines', load: (c: { caseId: string }) => ({ open: 2, caseId: c.caseId }) }, { slot: 'unbilled-time', load: () => { throw new Error('boom'); } }] },
		});
		const s = await slotStates(ctx, loaders);
		expect(s.map((x) => x.status)).toEqual(['filled', 'error', 'unavailable']);
		expect(s[0]).toMatchObject({ status: 'filled', data: { open: 2, caseId: 'c' } });
	});
	it('marks only the slot whose loader returns data the page cannot carry (a function, a class instance, a symbol)', async () => {
		class Summary { open = 2; }
		const states = async (bad: unknown) => (await slotStates(ctx, loadersFrom({
			'/src/lib/views/registers/overview-widgets.server.ts': { loaders: [{ slot: 'deadlines', load: () => bad }, { slot: 'unbilled-time', load: () => ({ hours: 1.5, at: new Date(0), tags: new Set(['a']), by: new Map([['x', [1n]]]) }) }] },
		}))).map((x) => x.status);
		for (const bad of [() => 1, { open: 2, fmt: () => '' }, new Summary(), [Symbol('x')], { [Symbol('k')]: 1 }, new Map([['k', new Summary()]])]) expect(await states(bad)).toEqual(['error', 'filled', 'unavailable']);
		const cyclic: Record<string, unknown> = { open: 1 };
		cyclic.self = cyclic;
		expect(await states(cyclic)).toEqual(['filled', 'filled', 'unavailable']);
	});
	it('refuses unknown slots, slots of another owner, double fills and files outside src/lib/views/<category>/', () => {
		const one = (file: string, entries: unknown[]) => () => collect({ [file]: { widgets: entries } }, 'widgets');
		expect(one('/src/lib/views/registers/overview-widgets.ts', [{ slot: 'nope' }])).toThrow(/unknown overview slot/);
		expect(one('/src/lib/views/evidence/overview-widgets.ts', [{ slot: 'deadlines' }])).toThrow(/belongs to GRS-17/);
		expect(one('/src/lib/views/registers/overview-widgets.ts', [{ slot: 'deadlines' }, { slot: 'deadlines' }])).toThrow(/filled twice/);
		expect(one('/src/routes/overview-widgets.ts', [{ slot: 'deadlines' }])).toThrow(/expected export/);
		expect(collect({ '/src/lib/views/system/overview-widgets.ts': { widgets: [{ slot: 'rescan-freshness' }] } }, 'widgets').has('rescan-freshness')).toBe(true);
	});
});
