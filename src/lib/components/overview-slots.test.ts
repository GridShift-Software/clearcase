// The overview widget-slot registry: owners fill only their own declared slots from their own subtree; unfilled
// slots name their owner; a failing widget loader marks its slot and never breaks the overview. Which slots are
// filled follows the tree (filledSlots, tests/e2e/pilot/lib/implemented.mjs), as the pilot checks do: every unfilled
// slot shows as unavailable and every filled slot has a loader, here and in a synthetic tree that fills one.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { filledSlots } from '../../../tests/e2e/pilot/lib/implemented.mjs';
import { loadersFrom, slotStates } from '../local-case/overview-widgets.server.ts';
import { collect, OVERVIEW_SLOTS, type OverviewWidgetLoader, type SlotId } from './overview-slots.ts';
import { widgets } from './overview-widgets.ts';

const ctx = { app: null, caseId: 'c', caseName: 'Case', resultsVersion: 'sha256:' + '0'.repeat(64) };
const REPO = join(import.meta.dirname, '..', '..', '..');
const tmp = mkdtempSync(join(tmpdir(), 'overview-slots-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Every unfilled slot is unavailable and every filled slot has a loader (its state is never 'unavailable'). */
async function expectSlotsFollow(filled: ReadonlySet<string>, loaders?: ReadonlyMap<SlotId, OverviewWidgetLoader>) {
	const s = await slotStates(ctx, loaders);
	for (const x of s) {
		if (filled.has(x.slot.id)) expect(x.status, `${x.slot.id} is filled in the tree but has no loader`).not.toBe('unavailable');
		else expect(x.status, x.slot.id).toBe('unavailable');
	}
}

describe('overview slots', () => {
	it('declares the GRS-17 deadline and time summaries and the GRS-20 freshness stamp', () => {
		expect(OVERVIEW_SLOTS.map((s) => [s.id, s.linear, s.category])).toEqual([['deadlines', 'GRS-17', 'registers'], ['unbilled-time', 'GRS-17', 'registers'], ['rescan-freshness', 'GRS-20', 'system']]);
		// the widgets discovered are exactly the slots the tree fills
		expect([...widgets.keys()].sort()).toEqual([...filledSlots(REPO, OVERVIEW_SLOTS)].sort());
	});
	it('shows every slot as unavailable until its owner fills it, and every filled slot has a loader (this tree)', async () => {
		await expectSlotsFollow(filledSlots(REPO, OVERVIEW_SLOTS));
	});
	it('the same rule on a synthetic tree that fills the deadlines slot', async () => {
		mkdirSync(join(tmp, 'src', 'lib', 'views', 'registers'), { recursive: true });
		writeFileSync(join(tmp, 'src', 'lib', 'views', 'registers', 'overview-widgets.ts'), "export const widgets = [{ slot: 'deadlines', component: null }];\n");
		const filled = filledSlots(tmp, OVERVIEW_SLOTS);
		expect([...filled]).toEqual(['deadlines']);
		await expectSlotsFollow(filled, loadersFrom({ '/src/lib/views/registers/overview-widgets.server.ts': { loaders: [{ slot: 'deadlines', load: () => ({ open: 1 }) }] } }));
		// a filled slot with no loader is caught
		await expect(expectSlotsFollow(filled, loadersFrom({}))).rejects.toThrow(/deadlines is filled in the tree but has no loader/);
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
