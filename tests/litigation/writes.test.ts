// The CC-08 write queue (GRS-18 r2) on an in-memory user-work double: version re-checks inside the queue, one row per
// step key whatever its status (D9), a repeated Add post stored once (D3), and seed deletions by overlay.
import { describe, expect, it } from 'vitest';
import { viewSeeds, type SeedOverlay, type SeedRow } from '../../src/lib/case-package/user-work.ts';
import type { RegisterRow, RegisterValue } from '../../src/lib/local-case/user-work.server.ts';
import { lostMessage, LOST, REQUEST_LIMIT } from '../../src/lib/views/litigation/submit.ts';
import { addEntry, deleteEntry, deleteSeed, rowVersion, saveStatus, seedVersion, stepRows, stepVersion, type Work } from '../../src/lib/views/litigation/writes.server.ts';

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

describe('addEntry', () => {
	it('D3: a repeated post of one form (same addId and fields) stores one row; another form stores its own', async () => {
		const { w, rows } = memoryWork(5);
		const [a, b] = await Promise.all([addEntry(w, 'c', 'heads', { head: 'x' }, 'aaaaaaaa-1'), addEntry(w, 'c', 'heads', { head: 'x' }, 'aaaaaaaa-1')]);
		expect(b).toEqual({ rowId: a.rowId, repeated: true });
		await addEntry(w, 'c', 'heads', { head: 'x' }, 'bbbbbbbb-2');
		expect(rows.map((r) => r.fields.seq)).toEqual([1, 2]);
	});
	it('parallel adds without an addId each get their own seq (lane 04 T1)', async () => {
		const { w, rows } = memoryWork(2);
		await Promise.all(Array.from({ length: 12 }, (_, i) => addEntry(w, 'c', 'heads', { head: String(i) })));
		expect(rows.map((r) => r.fields.seq)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
	});
});

describe('deleteEntry', () => {
	it('deletes at the shown version, refuses a changed row, and reports a gone one', async () => {
		const { w } = memoryWork();
		const id = (await addEntry(w, 'c', 'heads', { head: 'x' })).rowId;
		const shown = rowVersion(w.listRows('c', 'heads')[0]!);
		await w.putRow('c', 'heads', id, { head: 'changed', seq: 1 });
		expect(await deleteEntry(w, 'c', 'heads', id, shown)).toBe('stale');
		expect(await deleteEntry(w, 'c', 'heads', id, rowVersion(w.listRows('c', 'heads')[0]!))).toBe('deleted');
		expect(await deleteEntry(w, 'c', 'heads', id, shown)).toBe('gone');
		expect(await deleteEntry(w, 'c', 'heads', 'nope', null)).toBe('gone');
	});
});

describe('deleteSeed', () => {
	it('overlays a deletion at the shown version; a second one is gone; a changed seed is stale; an unknown is absent', async () => {
		const { w, overlays, seeds } = memoryWork();
		const shown = seedVersion(w.seedViews('c', 'rv', 'd')[0]!);
		expect(await deleteSeed(w, 'c', 'rv', 'd', 'zz', null)).toBe('absent');
		seeds[0] = { ...seeds[0]!, seedSha256: 'h2' };
		expect(await deleteSeed(w, 'c', 'rv', 'd', 's1', shown)).toBe('stale');
		expect(await deleteSeed(w, 'c', 'rv', 'd', 's1', seedVersion(w.seedViews('c', 'rv', 'd')[0]!))).toBe('deleted');
		expect(overlays).toEqual([{ caseId: 'c', datasetKey: 'd', seedId: 's1', baseSeedSha256: 'h2', fields: { deleted: true } }]);
		expect(await deleteSeed(w, 'c', 'rv', 'd', 's1', null)).toBe('gone');
	});
});

describe('saveStatus (D9: one row per step key)', () => {
	it("'' → Done → '' → Done leaves one row, keeping its seq", async () => {
		const { w, rows } = memoryWork();
		await w.putRow('c', 'enf', null, { stepKey: 'other', status: 'Done', seq: 1 });
		for (const s of ['', 'Done', '', 'Done']) expect(await saveStatus(w, 'c', 'enf', 'k', s, null)).toBe('saved');
		expect(stepRows(rows, 'k').map((r) => r.fields)).toEqual([{ stepKey: 'k', status: 'Done', seq: 2 }]);
	});
	it('collapses rows an older store holds for one key onto the latest', async () => {
		const { w, rows } = memoryWork();
		for (const [s, q] of [['', 1], ['Done', 2], ['', 3]] as const) await w.putRow('c', 'enf', null, { stepKey: 'k', status: s, seq: q });
		expect(await saveStatus(w, 'c', 'enf', 'k', 'Monitor', stepVersion(stepRows(rows, 'k')))).toBe('saved');
		expect(stepRows(rows, 'k').map((r) => r.fields)).toEqual([{ stepKey: 'k', status: 'Monitor', seq: 3 }]);
	});
	it('refuses a save against a version changed since (two tabs)', async () => {
		const { w, rows } = memoryWork();
		const shown = stepVersion(stepRows(rows, 'k'));
		expect(shown).toBe('none');
		expect(await saveStatus(w, 'c', 'enf', 'k', 'Done', shown)).toBe('saved');
		expect(await saveStatus(w, 'c', 'enf', 'k', 'Monitor', shown)).toBe('stale');
		expect(stepRows(rows, 'k').map((r) => r.fields.status)).toEqual(['Done']);
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
