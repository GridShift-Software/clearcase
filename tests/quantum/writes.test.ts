// Payment writes (GRS-16, CC-06 r2, D1 to D3): one queue per case, seq computed inside it, and the Delete's
// stored-fields check. A fake store whose writes wait on a gate stands in for a busy work.sqlite (the real store's busy
// retries await for about 10 s); the browser suite drives the same races through the production entry.
import { describe, expect, it } from 'vitest';
import type { RegisterRow, RegisterValue } from '../../src/lib/local-case/user-work.server';
import { PAYMENTS_STORE } from '../../src/lib/views/quantum/payments';
import { addPayment, deletePayment, fieldsHash, listPayments, type Work } from '../../src/lib/views/quantum/writes.server';

/** An in-memory store: every write first awaits `gate` (held: the store is busy). */
function fakeStore() {
	const rows = new Map<string, RegisterRow>();
	let n = 0;
	let open: () => void = () => {};
	const s = {
		rows,
		gate: Promise.resolve() as Promise<void>,
		hold() { s.gate = new Promise((r) => { open = r; }); },
		release() { open(); },
		listRows: (caseId: string, store: string) => [...rows.values()].filter((r) => r.store === store && (r as RegisterRow & { caseId: string }).caseId === caseId),
		async putRow(caseId: string, store: string, rowId: string | null, fields: Record<string, RegisterValue>) {
			await s.gate;
			const id = rowId ?? `row-${String(++n).padStart(3, '0')}-${Math.random().toString(36).slice(2, 6)}`;
			rows.set(id, { rowId: id, store, anchor: null, fields, createdAt: '2026-10-08T09:00:00.000Z', updatedAt: '2026-10-08T09:00:00.000Z', intact: true, caseId } as RegisterRow);
			return id;
		},
		async deleteRow(_caseId: string, _store: string, rowId: string) { await s.gate; return rows.delete(rowId); },
	};
	return s as typeof s & Work;
}
const entry = (note: string, amount = '2.00') => ({ date: '2089-04-01', amount, method: 'Synthetic', note });

describe('the payment write queue (D3)', () => {
	it('two Adds posted while the store is busy store distinct seq values, in submission order, and both rows survive', async () => {
		const w = fakeStore();
		await addPayment(w, 'c1', entry('Synthetic first', '1.00'), 100n);
		w.hold();
		const a = addPayment(w, 'c1', entry('Synthetic tab A'), 200n);
		const b = addPayment(w, 'c1', entry('Synthetic tab B'), 300n);
		await new Promise((r) => setTimeout(r, 20));
		w.release();
		await Promise.all([a, b]);
		const shown = listPayments(w, 'c1');
		expect(shown.map((p) => [p.note, p.seq])).toEqual([['Synthetic first', 1], ['Synthetic tab A', 2], ['Synthetic tab B', 3]]);
	});
	it('a failed write does not block the queue, and the next Add still gets the next seq', async () => {
		const w = fakeStore();
		const put = w.putRow;
		w.putRow = async () => { throw new Error('busy'); };
		await expect(addPayment(w, 'c1', entry('Synthetic refused'), 1n)).rejects.toThrow('busy');
		w.putRow = put;
		await addPayment(w, 'c1', entry('Synthetic saved'), 1n);
		expect(listPayments(w, 'c1').map((p) => [p.note, p.seq])).toEqual([['Synthetic saved', 1]]);
	});
	it('queues per case: another case\'s busy write does not hold this case back, and seq counts per case', async () => {
		const w = fakeStore();
		await addPayment(w, 'c1', entry('Synthetic c1'), 1n);
		await addPayment(w, 'c2', entry('Synthetic c2'), 1n);
		expect([listPayments(w, 'c1')[0]!.seq, listPayments(w, 'c2')[0]!.seq]).toEqual([1, 1]);
	});
});

describe('the Delete recheck (D1 to D3)', () => {
	it('deletes the row when its stored fields still hash to what the page showed', async () => {
		const w = fakeStore();
		const id = await addPayment(w, 'c1', entry('Synthetic keep'), 1n);
		const shown = listPayments(w, 'c1')[0]!;
		expect(await deletePayment(w, 'c1', id, shown.hash)).toBe('deleted');
		expect(listPayments(w, 'c1')).toEqual([]);
	});
	it('refuses a row whose stored fields changed since the page showed them (a restore), and keeps it', async () => {
		const w = fakeStore();
		const id = await addPayment(w, 'c1', entry('Synthetic before'), 1n);
		const shown = listPayments(w, 'c1')[0]!;
		const row = w.rows.get(id)!;
		w.rows.set(id, { ...row, fields: { ...row.fields, note: 'Synthetic restored' } });
		expect(await deletePayment(w, 'c1', id, shown.hash)).toBe('stale');
		expect(listPayments(w, 'c1').map((p) => p.note)).toEqual(['Synthetic restored']);
	});
	it('reports a row that is already gone, and deletes nothing else', async () => {
		const w = fakeStore();
		const x = await addPayment(w, 'c1', entry('Synthetic twice'), 1n);
		await addPayment(w, 'c1', entry('Synthetic survivor'), 1n);
		const h = listPayments(w, 'c1')[0]!.hash;
		expect(await deletePayment(w, 'c1', x, h)).toBe('deleted');
		expect(await deletePayment(w, 'c1', x, h)).toBe('gone');
		expect(listPayments(w, 'c1').map((p) => p.note)).toEqual(['Synthetic survivor']);
	});
	it('a Delete queued behind a busy Add sees the store after that Add', async () => {
		const w = fakeStore();
		const id = await addPayment(w, 'c1', entry('Synthetic target'), 1n);
		const h = listPayments(w, 'c1')[0]!.hash;
		w.hold();
		const add = addPayment(w, 'c1', entry('Synthetic in flight'), 1n);
		const del = deletePayment(w, 'c1', id, h);
		w.release();
		expect([await add.then(() => 'added'), await del]).toEqual(['added', 'deleted']);
		expect(listPayments(w, 'c1').map((p) => [p.note, p.seq])).toEqual([['Synthetic in flight', 2]]);
	});
	it('hashes the stored fields, not updatedAt: equal fields hash equally, any changed field differs', () => {
		const f = { date: '2089-04-01', amount: '2.00', amountCents: 200, method: 'Synthetic', note: 'n', seq: 1 };
		expect(fieldsHash(f)).toBe(fieldsHash({ ...f }));
		expect(fieldsHash({ ...f, note: 'n2' })).not.toBe(fieldsHash(f));
		expect(fieldsHash({ ...f, seq: 2 })).not.toBe(fieldsHash(f));
	});
	it('lists the store the page reads', () => expect(PAYMENTS_STORE).toBe('payments'));
});
