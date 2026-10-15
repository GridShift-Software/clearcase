import { describe, expect, it } from 'vitest';
import { viewSeeds, type SeedOverlay, type SeedRow } from '../case-package/browser.ts';
import { registers, type Work } from './registers.server.ts';
import type { RegisterRow, RegisterValue } from './user-work.server.ts';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function memoryWork() {
	const rows: (RegisterRow & { caseId: string })[] = [];
	const overlays: (SeedOverlay & { caseId: string })[] = [];
	const seeds: SeedRow[] = [{ datasetKey: 'd', seedId: 's1', seedSha256: 'h1', record: {} }];
	let n = 0;
	let open = () => {};
	const m = {
		rows, overlays, seeds, log: [] as string[],
		gate: Promise.resolve() as Promise<void>,
		hold() { m.gate = new Promise((r) => { open = r; }); },
		release() { open(); },
		listRows: (caseId: string, store: string) => rows.filter((r) => r.caseId === caseId && r.store === store).map(({ caseId: _, ...r }) => ({ ...r, fields: { ...r.fields } })),
		async putRow(caseId: string, store: string, rowId: string | null, fields: Record<string, RegisterValue>) {
			await m.gate;
			const id = rowId ?? `row-${++n}`;
			const at = rows.findIndex((r) => r.caseId === caseId && r.store === store && r.rowId === id);
			const row = { caseId, rowId: id, store, anchor: null, fields: { ...fields }, createdAt: 'T', updatedAt: `T${n++}`, intact: true };
			if (at < 0) rows.push(row); else rows[at] = row;
			m.log.push(`put ${store} ${id}`);
			return id;
		},
		async deleteRow(caseId: string, store: string, rowId: string) {
			await m.gate;
			const at = rows.findIndex((r) => r.caseId === caseId && r.store === store && r.rowId === rowId);
			if (at < 0) return false;
			rows.splice(at, 1);
			return true;
		},
		seedViews: (caseId: string, _rv: string, datasetKey?: string) => viewSeeds(seeds.filter((s) => !datasetKey || s.datasetKey === datasetKey), overlays.filter((o) => o.caseId === caseId)),
		async putSeedOverlay(o: SeedOverlay) {
			await m.gate;
			const at = overlays.findIndex((x) => x.caseId === o.caseId && x.seedId === o.seedId);
			const v = { ...o, caseId: o.caseId };
			if (at < 0) overlays.push(v); else overlays[at] = v;
		},
	};
	return m as typeof m & Work;
}
const seqs = (w: Work, store = 'heads', caseId = 'c') => registers(w).open(caseId, store).rows().map((r) => r.fields.seq);

describe('rows()', () => {
	it('lists rows in insertion order: by seq, rows without one last, then by creation time and id', () => {
		const w = memoryWork();
		const at = (rowId: string, createdAt: string, seq?: number) => w.rows.push({ caseId: 'c', rowId, store: 'heads', anchor: null, fields: seq === undefined ? { x: rowId } : { x: rowId, seq }, createdAt, updatedAt: createdAt, intact: true });
		at('z', 'T1', 2); at('y', 'T2'); at('a', 'T3', 1); at('b', 'T1'); at('c', 'T1');
		expect(registers(w).open('c', 'heads').rows().map((r) => r.rowId)).toEqual(['a', 'z', 'b', 'c', 'y']);
	});
	it("gives each row a version of its stored fields: equal fields agree, a changed field differs, updatedAt does not count", async () => {
		const w = memoryWork();
		const s = registers(w).open('c', 'heads');
		const { rowId } = await s.add({ head: 'x' });
		const v1 = s.rows()[0]!.version;
		await w.putRow('c', 'heads', rowId, { head: 'x', seq: 1 });
		expect(s.rows()[0]!.version).toBe(v1);
		await w.putRow('c', 'heads', rowId, { head: 'y', seq: 1 });
		expect(s.rows()[0]!.version).not.toBe(v1);
	});
});

describe('add()', () => {
	it('adds posted while the store is busy store distinct seq values in submission order, and all survive', async () => {
		const w = memoryWork();
		const s = registers(w).open('c', 'heads');
		await s.add({ head: 'first' });
		w.hold();
		const pending = Array.from({ length: 6 }, (_, i) => s.add({ head: `tab ${i}` }));
		await tick(10);
		w.release();
		await Promise.all(pending);
		expect(s.rows().map((r) => [r.fields.head, r.fields.seq])).toEqual([['first', 1], ...Array.from({ length: 6 }, (_, i) => [`tab ${i}`, i + 2])]);
	});
	it('a repeated post of one form (same addId and fields) stores one row; another form stores its own', async () => {
		const w = memoryWork();
		const s = registers(w).open('c', 'heads');
		const [a, b] = await Promise.all([s.add({ head: 'x' }, { addId: 'aaaaaaaa-1' }), s.add({ head: 'x' }, { addId: 'aaaaaaaa-1' })]);
		expect(b).toEqual({ rowId: a.rowId, repeated: true });
		expect((await s.add({ head: 'x' }, { addId: 'bbbbbbbb-2' })).repeated).toBe(false);
		expect(seqs(w)).toEqual([1, 2]);
	});
	it('a failed write rejects, does not block the queue, and the next add still gets the next seq', async () => {
		const w = memoryWork();
		const s = registers(w).open('c', 'heads');
		const put = w.putRow;
		w.putRow = async () => { throw new Error('busy'); };
		await expect(s.add({ head: 'refused' })).rejects.toThrow('busy');
		w.putRow = put;
		await s.add({ head: 'saved' });
		expect(s.rows().map((r) => [r.fields.head, r.fields.seq])).toEqual([['saved', 1]]);
	});
	it('queues and counts seq per case and store: another busy store does not hold this one back', async () => {
		const w = memoryWork();
		await registers(w).open('c', 'heads').add({ head: 'x' });
		await registers(w).open('c2', 'heads').add({ head: 'x' });
		await registers(w).open('c', 'other').add({ head: 'x' });
		expect([seqs(w), seqs(w, 'heads', 'c2'), seqs(w, 'other')]).toEqual([[1], [1], [1]]);
	});
});

describe('replace()', () => {
	it('replaces at the shown version keeping the seq, refuses a changed row, and never re-creates a gone one', async () => {
		const w = memoryWork();
		const s = registers(w).open('c', 'heads');
		await s.add({ head: 'a' });
		const { rowId } = await s.add({ head: 'b' });
		const shown = s.rows()[1]!.version;
		expect(await s.replace(rowId, shown, { head: 'b2' })).toBe('replaced');
		expect(s.rows().map((r) => [r.fields.head, r.fields.seq])).toEqual([['a', 1], ['b2', 2]]);
		expect(await s.replace(rowId, shown, { head: 'b3' })).toBe('stale');
		expect(await s.replace(rowId, null, { head: 'b4' })).toBe('replaced');
		await w.deleteRow('c', 'heads', rowId);
		expect(await s.replace(rowId, null, { head: 'b5' })).toBe('gone');
		expect(s.rows().map((r) => r.fields.head)).toEqual(['a']);
	});
});

describe('remove()', () => {
	it('deletes at the shown version, refuses a changed row and keeps it, and reports a gone one', async () => {
		const w = memoryWork();
		const s = registers(w).open('c', 'heads');
		const { rowId } = await s.add({ head: 'x' });
		const shown = s.rows()[0]!.version;
		await w.putRow('c', 'heads', rowId, { head: 'changed', seq: 1 });
		expect(await s.remove(rowId, shown)).toBe('stale');
		expect(s.rows().map((r) => r.fields.head)).toEqual(['changed']);
		expect(await s.remove(rowId, s.rows()[0]!.version)).toBe('deleted');
		expect(await s.remove(rowId, shown)).toBe('gone');
		expect(await s.remove('nope', null)).toBe('gone');
	});
	it('two removes posted with one version while the store is busy: one deletes, the other is gone (lost update)', async () => {
		const w = memoryWork();
		const s = registers(w).open('c', 'heads');
		const { rowId } = await s.add({ head: 'x' });
		await s.add({ head: 'survivor' });
		const shown = s.rows()[0]!.version;
		w.hold();
		const both = Promise.all([s.remove(rowId, shown), s.remove(rowId, shown)]);
		await tick(10);
		w.release();
		expect(await both).toEqual(['deleted', 'gone']);
		expect(s.rows().map((r) => r.fields.head)).toEqual(['survivor']);
	});
	it('a remove queued behind a busy add sees the store after that add', async () => {
		const w = memoryWork();
		const s = registers(w).open('c', 'heads');
		const { rowId } = await s.add({ head: 'target' });
		const shown = s.rows()[0]!.version;
		w.hold();
		const add = s.add({ head: 'in flight' });
		const del = s.remove(rowId, shown);
		w.release();
		expect([await add.then(() => 'added'), await del]).toEqual(['added', 'deleted']);
		expect(s.rows().map((r) => [r.fields.head, r.fields.seq])).toEqual([['in flight', 2]]);
	});
});

describe('batch()', () => {
	it('runs several writes as one queued step: no other write of the store lands in between', async () => {
		const w = memoryWork();
		const s = registers(w).open('c', 'enf');
		await s.add({ k: 'a' });
		w.hold();
		const b = s.batch(async (tx) => {
			const [first] = tx.rows();
			await tx.replace(first!.rowId, first!.version, { k: 'a2' });
			await tx.add({ k: 'b' });
			return tx.rows().map((r) => r.fields.k);
		});
		const after = s.add({ k: 'c' });
		await tick(5);
		w.release();
		expect(await b).toEqual(['a2', 'b']);
		await after;
		expect(s.rows().map((r) => [r.fields.k, r.fields.seq])).toEqual([['a2', 1], ['b', 2], ['c', 3]]);
	});
});

describe('seeds()', () => {
	it('removes an imported topic by overlay at the shown version; a second is gone, a changed seed stale, an unknown absent', async () => {
		const w = memoryWork();
		const seeds = () => registers(w).seeds('c', 'rv', 'd');
		const shown = seeds().views()[0]!.version;
		expect(await seeds().remove('zz', null)).toBe('absent');
		w.seeds[0] = { ...w.seeds[0]!, seedSha256: 'h2' };
		expect(await seeds().remove('s1', shown)).toBe('stale');
		expect(await seeds().remove('s1', seeds().views()[0]!.version)).toBe('deleted');
		expect(w.overlays).toEqual([{ caseId: 'c', datasetKey: 'd', seedId: 's1', baseSeedSha256: 'h2', fields: { deleted: true } }]);
		expect(await seeds().remove('s1', null)).toBe('gone');
	});
});

describe('exclusive()', () => {
	it("waits for the case's queued writes, holds back the case's later writes until it ends, and leaves other cases alone", async () => {
		const w = memoryWork();
		const order: string[] = [];
		w.hold();
		const before = registers(w).open('c', 'heads').add({ head: 'before' }).then(() => order.push('before'));
		const seedBefore = registers(w).seeds('c', 'rv', 'd').remove('s1', null).then(() => order.push('seed'));
		const ex = registers(w).exclusive('c', async () => { order.push('exclusive start'); await tick(20); order.push('exclusive end'); });
		const after = registers(w).open('c', 'payments').add({ p: 1 }).then(() => order.push('after'));
		const other = registers(w).open('c2', 'heads').add({ head: 'other' }).then(() => order.push('other case'));
		await tick(5);
		w.release();
		await Promise.all([before, seedBefore, ex, after, other]);
		expect(order.indexOf('exclusive start')).toBeGreaterThan(Math.max(order.indexOf('before'), order.indexOf('seed')));
		expect(order.indexOf('after')).toBeGreaterThan(order.indexOf('exclusive end'));
		expect(order.indexOf('other case')).toBeLessThan(order.indexOf('exclusive end'));
	});
	it('a failed exclusive run rejects and does not block the case', async () => {
		const w = memoryWork();
		await expect(registers(w).exclusive('c', async () => { throw new Error('restore failed'); })).rejects.toThrow('restore failed');
		await registers(w).open('c', 'heads').add({ head: 'x' });
		expect(seqs(w)).toEqual([1]);
	});
	it('a write through the store from inside the run runs in it, in order, and the case stays usable', { timeout: 500 }, async () => {
		const w = memoryWork();
		const r = registers(w);
		const out = await r.exclusive('c', async () => {
			const a = await r.open('c', 'heads').add({ head: 'inside 1' });
			await Promise.all([r.open('c', 'heads').add({ head: 'inside 2' }), r.open('c', 'payments').add({ p: 1 })]);
			return a.rowId;
		});
		expect(out).toMatch(/^row-/);
		expect(seqs(w)).toEqual([1, 2]);
		expect(seqs(w, 'payments')).toEqual([1]);
		await r.open('c', 'heads').add({ head: 'after' });
		expect(r.open('c', 'heads').rows().map((x) => x.fields.head)).toEqual(['inside 1', 'inside 2', 'after']);
	});
	it("inside a run, another case's write and a nested exclusive of the same case still settle", { timeout: 500 }, async () => {
		const w = memoryWork();
		const r = registers(w);
		await r.exclusive('c', async () => {
			await r.open('c2', 'heads').add({ head: 'other' });
			await r.exclusive('c', async () => { await r.open('c', 'heads').add({ head: 'nested' }); });
		});
		expect(w.listRows('c', 'heads').map((x) => x.fields.head)).toEqual(['nested']);
	});
	it('a write a settled nested run left on a timer runs in the enclosing run while that is still open', { timeout: 500 }, async () => {
		const w = memoryWork();
		const r = registers(w);
		await r.exclusive('c', async () => {
			let late: Promise<unknown> = DONE;
			await r.exclusive('c', async () => { late = new Promise((done) => setTimeout(() => done(r.open('c', 'heads').add({ head: 'late' })), 10)); });
			await late;
		});
		expect(seqs(w)).toEqual([1]);
	});
});
const DONE = Promise.resolve();

describe('re-entry from batch()', () => {
	it('a write to the same store from inside a batch runs in it instead of waiting on it', { timeout: 500 }, async () => {
		const w = memoryWork();
		const s = registers(w).open('c', 'enf');
		await s.batch(async () => { await s.add({ k: 'inside' }); });
		await s.add({ k: 'after' });
		expect(s.rows().map((x) => x.fields.k)).toEqual(['inside', 'after']);
	});
	it('a write to another store, or an exclusive run, from inside a batch throws at once and names the rule', { timeout: 500 }, async () => {
		const w = memoryWork();
		const r = registers(w);
		await expect(r.open('c', 'enf').batch(() => r.open('c', 'other').add({ k: 1 }))).rejects.toThrow(/inside a batch/);
		await expect(r.open('c', 'enf').batch(() => r.exclusive('c', async () => 1))).rejects.toThrow(/inside a batch/);
		await r.open('c', 'enf').add({ k: 'usable' });
		expect(w.listRows('c', 'enf')).toHaveLength(1);
	});
});
