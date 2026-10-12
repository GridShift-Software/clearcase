// The CC-08 status save (GRS-18 r2) on an in-memory user-work double: one row per step key whatever its status (D9),
// re-checked against the step version. Adds, Deletes, seed deletions and their races are the register store's
// (src/lib/local-case/registers.test.ts).
import { describe, expect, it } from 'vitest';
import { viewSeeds, type SeedOverlay, type SeedRow } from '../../src/lib/case-package/user-work.ts';
import { registers } from '../../src/lib/local-case/registers.server.ts';
import type { RegisterRow, RegisterValue } from '../../src/lib/local-case/user-work.server.ts';
import { lostMessage, LOST, REQUEST_LIMIT } from '../../src/lib/views/litigation/submit.ts';
import { saveStatus, stepRows, stepVersion, type Work } from '../../src/lib/views/litigation/writes.server.ts';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

function memoryWork(delay = 0) {
	const rows: RegisterRow[] = [];
	const overlays: SeedOverlay[] = [];
	let n = 0;
	const w: Work = {
		listRows: (caseId, store) => rows.filter((r) => r.store === store).map((r) => ({ ...r, fields: { ...r.fields } })),
		putRow: async (caseId, store, rowId, fields) => {
			await tick(delay);
			const id = rowId ?? `row-${++n}`;
			const at = rows.findIndex((r) => r.rowId === id);
			const row: RegisterRow = { rowId: id, store, anchor: null, fields: fields as Record<string, RegisterValue>, createdAt: 'T', updatedAt: 'T', intact: true };
			if (at < 0) rows.push(row); else rows[at] = row;
			return id;
		},
		deleteRow: async (caseId, store, rowId) => { const at = rows.findIndex((r) => r.rowId === rowId); if (at < 0) return false; rows.splice(at, 1); return true; },
		seedViews: () => viewSeeds(seeds, overlays),
		putSeedOverlay: async (o) => { const at = overlays.findIndex((x) => x.seedId === o.seedId); if (at < 0) overlays.push(o as SeedOverlay); else overlays[at] = o as SeedOverlay; },
	} as Work;
	const seeds: SeedRow[] = [{ datasetKey: 'd', seedId: 's1', seedSha256: 'h1', record: {} }];
	return { w, rows, overlays, seeds };
}

const step = (w: Work, k = 'k') => stepRows(registers(w).open('c', 'enf').rows(), k);

describe('saveStatus (D9: one row per step key)', () => {
	it("'' → Done → '' → Done leaves one row, keeping its seq", async () => {
		const { w } = memoryWork();
		await w.putRow('c', 'enf', null, { stepKey: 'other', status: 'Done', seq: 1 });
		for (const s of ['', 'Done', '', 'Done']) expect(await saveStatus(w, 'c', 'enf', 'k', s, null)).toBe('saved');
		expect(step(w).map((r) => r.fields)).toEqual([{ stepKey: 'k', status: 'Done', seq: 2 }]);
	});
	it('collapses rows an older store holds for one key onto the latest', async () => {
		const { w } = memoryWork();
		for (const [s, q] of [['', 1], ['Done', 2], ['', 3]] as const) await w.putRow('c', 'enf', null, { stepKey: 'k', status: s, seq: q });
		expect(await saveStatus(w, 'c', 'enf', 'k', 'Monitor', stepVersion(step(w)))).toBe('saved');
		expect(step(w).map((r) => r.fields)).toEqual([{ stepKey: 'k', status: 'Monitor', seq: 3 }]);
	});
	it('refuses a save against a version changed since (two tabs)', async () => {
		const { w } = memoryWork();
		const shown = stepVersion(step(w));
		expect(shown).toBe('none');
		expect(await saveStatus(w, 'c', 'enf', 'k', 'Done', shown)).toBe('saved');
		expect(await saveStatus(w, 'c', 'enf', 'k', 'Monitor', shown)).toBe('stale');
		const saved = stepVersion(step(w));
		expect(await saveStatus(w, 'c', 'enf', 'k', 'Monitor', saved)).toBe('saved');
		expect(await saveStatus(w, 'c', 'enf', 'k', 'Done', saved)).toBe('stale');
		expect(step(w).map((r) => r.fields.status)).toEqual(['Monitor']);
	});
});

describe('lostMessage (D18)', () => {
	it('a 413 says too large, names the limit, keeps the input and offers no retry', () => {
		const m = lostMessage('add', 413);
		expect(m.retry).toBe(false);
		expect(m.message).toContain('too large');
		expect(m.message).toContain(REQUEST_LIMIT);
		expect(m.message).not.toMatch(/could not be reached|try again/);
	});
	it('no status is a lost request; another status is an app error', () => {
		expect(lostMessage('add')).toEqual({ message: LOST, retry: true });
		expect(lostMessage('delete').message).toMatch(/^Not deleted: the app could not be reached/);
		expect(lostMessage('status', 500).message).toMatch(/reported an error \(500\)/);
	});
});
